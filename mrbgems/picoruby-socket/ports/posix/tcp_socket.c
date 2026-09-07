#include "../../include/socket.h"
#include <stdio.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <unistd.h>
#include <string.h>
#include <errno.h>
#include <sys/ioctl.h>
#include <sys/poll.h>
#include <sys/wait.h>
#include <signal.h>
#include <fcntl.h>
#include <limits.h>
#include "machine.h"

#ifndef MSG_NOSIGNAL
#define MSG_NOSIGNAL 0
#endif

/* Prevent name collision with embedded Ruby bytecode */
#ifdef socket
#undef socket
#endif

static int
wait_for_fd(int fd, short events, int64_t deadline_us)
{
  struct pollfd poll_fd;
  poll_fd.fd = fd;
  poll_fd.events = events;
  poll_fd.revents = 0;

  while (true) {
    int timeout_ms = -1;
    if (deadline_us > 0) {
      int64_t remaining = deadline_us - (int64_t)Machine_uptime_us();
      if (remaining <= 0 || remaining < 1000) return 0;
      int64_t milliseconds = remaining / 1000;
      timeout_ms = milliseconds > INT_MAX ? INT_MAX : (int)milliseconds;
    }
    int result = poll(&poll_fd, 1, timeout_ms);
    if (result > 0) return 1;
    if (result == 0) return 0;
    if (errno != EINTR) return -1;
  }
}

typedef struct {
  int status;
  struct in_addr address;
} dns_result_t;

static int
resolve_with_deadline(const char *host, struct in_addr *address, int64_t deadline_us)
{
  if (inet_pton(AF_INET, host, address) == 1) return 0;

  if (deadline_us <= 0) {
    struct addrinfo hints;
    struct addrinfo *result = NULL;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    int error = getaddrinfo(host, NULL, &hints, &result);
    if (error != 0 || !result) return -1;
    *address = ((struct sockaddr_in *)result->ai_addr)->sin_addr;
    freeaddrinfo(result);
    return 0;
  }

  int pipe_fds[2];
  if (pipe(pipe_fds) != 0) return -2;
  pid_t child = fork();
  if (child < 0) {
    close(pipe_fds[0]);
    close(pipe_fds[1]);
    return -2;
  }
  if (child == 0) {
    close(pipe_fds[0]);
    dns_result_t output;
    memset(&output, 0, sizeof(output));
    struct addrinfo hints;
    struct addrinfo *result = NULL;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    int error = getaddrinfo(host, NULL, &hints, &result);
    if (error == 0 && result) {
      output.status = 0;
      output.address = ((struct sockaddr_in *)result->ai_addr)->sin_addr;
      freeaddrinfo(result);
    } else {
      output.status = -1;
    }
    const char *bytes = (const char *)&output;
    size_t offset = 0;
    while (offset < sizeof(output)) {
      ssize_t written = write(pipe_fds[1], bytes + offset, sizeof(output) - offset);
      if (written > 0) offset += (size_t)written;
      else if (written < 0 && errno == EINTR) continue;
      else break;
    }
    close(pipe_fds[1]);
    _exit(0);
  }

  close(pipe_fds[1]);
  int ready = wait_for_fd(pipe_fds[0], POLLIN, deadline_us);
  dns_result_t output;
  size_t offset = 0;
  if (ready > 0) {
    while (offset < sizeof(output)) {
      ssize_t received = read(pipe_fds[0], ((char *)&output) + offset,
                              sizeof(output) - offset);
      if (received > 0) offset += (size_t)received;
      else if (received < 0 && errno == EINTR) continue;
      else break;
    }
  }
  close(pipe_fds[0]);
  if (ready <= 0) kill(child, SIGKILL);
  while (waitpid(child, NULL, 0) < 0 && errno == EINTR) {}
  if (ready == 0) return -3;
  if (ready < 0 || offset != sizeof(output)) return -2;
  if (output.status != 0) return -1;
  *address = output.address;
  return 0;
}

/* Create a new TCP socket */
bool
TCPSocket_create(picorb_state *vm, picorb_socket_t *sock)
{
  if (!sock) return false;

  memset(sock, 0, sizeof(picorb_socket_t));

  sock->fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (sock->fd < 0) {
    return false;
  }

  sock->family = AF_INET;
  sock->socktype = SOCK_STREAM;
  sock->protocol = IPPROTO_TCP;
  sock->connected = false;
  sock->closed = false;
  sock->transport_error = PICORB_TRANSPORT_OK;

#ifdef SO_NOSIGPIPE
  int enabled = 1;
  setsockopt(sock->fd, SOL_SOCKET, SO_NOSIGPIPE, &enabled, sizeof(enabled));
#endif

  return true;
}

/* Connect to remote host */
bool
TCPSocket_connect(picorb_state *vm, picorb_socket_t *sock, const char *host, int port)
{
  return TCPSocket_connect_deadline(vm, sock, host, port, 0);
}

bool
TCPSocket_connect_deadline(picorb_state *vm, picorb_socket_t *sock,
                           const char *host, int port, int64_t deadline_us)
{
  if (!sock || !host || port <= 0 || port > 65535) {
    return false;
  }

  /* Create socket if not already created */
  if (sock->fd < 0) {
    if (!TCPSocket_create(vm, sock)) {
      return false;
    }
  }

  /* Resolve hostname */
  struct sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_port = htons(port);

  int dns_result = resolve_with_deadline(host, &addr.sin_addr, deadline_us);
  if (dns_result != 0) {
    sock->transport_error = dns_result == -3 ? PICORB_TRANSPORT_DNS_TIMEOUT :
      (dns_result == -2 ? PICORB_TRANSPORT_RESOURCE_EXHAUSTED : PICORB_TRANSPORT_DNS_FAILED);
    close(sock->fd);
    sock->fd = -1;
    return false;
  }

  if (deadline_us > 0) {
    int flags = fcntl(sock->fd, F_GETFL, 0);
    if (flags < 0 || fcntl(sock->fd, F_SETFL, flags | O_NONBLOCK) < 0) {
      sock->transport_error = PICORB_TRANSPORT_CONNECT_FAILED;
      close(sock->fd);
      sock->fd = -1;
      return false;
    }
  }

  int result;
  do {
    result = connect(sock->fd, (struct sockaddr *)&addr, sizeof(addr));
  } while (result < 0 && errno == EINTR &&
           (deadline_us <= 0 || (int64_t)Machine_uptime_us() < deadline_us));
  if (result < 0 && deadline_us > 0 && errno == EINPROGRESS) {
    int ready = wait_for_fd(sock->fd, POLLOUT, deadline_us);
    if (ready > 0) {
      int socket_error = 0;
      socklen_t error_length = sizeof(socket_error);
      if (getsockopt(sock->fd, SOL_SOCKET, SO_ERROR, &socket_error, &error_length) != 0 || socket_error != 0) {
        result = -1;
      } else {
        result = 0;
      }
    } else {
      sock->transport_error = ready == 0 ? PICORB_TRANSPORT_CONNECT_TIMEOUT : PICORB_TRANSPORT_CONNECT_FAILED;
      result = -1;
    }
  }
  if (result < 0) {
    if (sock->transport_error == PICORB_TRANSPORT_OK) {
      sock->transport_error = deadline_us > 0 &&
        (int64_t)Machine_uptime_us() >= deadline_us ?
        PICORB_TRANSPORT_CONNECT_TIMEOUT : PICORB_TRANSPORT_CONNECT_FAILED;
    }
    close(sock->fd);
    sock->fd = -1;
    return false;
  }

  /* Save connection info */
  strncpy(sock->remote_host, host, sizeof(sock->remote_host) - 1);
  sock->remote_host[sizeof(sock->remote_host) - 1] = '\0';
  sock->remote_port = port;
  sock->connected = true;
  sock->transport_error = PICORB_TRANSPORT_OK;

  return true;
}

int
TCPSocket_connection_state(picorb_state *vm, picorb_socket_t *sock)
{
  (void)vm;
  return sock && sock->connected ? SOCKET_STATE_CONNECTED : SOCKET_STATE_ERROR;
}

/* Send data */
ssize_t
TCPSocket_send(picorb_state *vm, picorb_socket_t *sock, const void *data, size_t len)
{
  if (!sock || !data || sock->fd < 0 || sock->closed) {
    return -1;
  }

  ssize_t sent = send(sock->fd, data, len, 0);
  if (sent < 0) {
    return -1;
  }

  return sent;
}

ssize_t
TCPSocket_send_deadline(picorb_state *vm, picorb_socket_t *sock,
                        const void *data, size_t len, int64_t deadline_us)
{
  (void)vm;
  if (!sock || !data || sock->fd < 0 || sock->closed || len > (size_t)SSIZE_MAX) {
    if (sock) sock->transport_error = PICORB_TRANSPORT_WRITE_FAILED;
    return -1;
  }
  while (true) {
    ssize_t sent = send(sock->fd, data, len, MSG_DONTWAIT | MSG_NOSIGNAL);
    if (sent >= 0) return sent;
    if (errno == EINTR) continue;
    if (errno != EAGAIN && errno != EWOULDBLOCK) {
      sock->transport_error = PICORB_TRANSPORT_WRITE_FAILED;
      return -1;
    }
    int ready = wait_for_fd(sock->fd, POLLOUT, deadline_us);
    if (ready <= 0) {
      sock->transport_error = ready == 0 ? PICORB_TRANSPORT_WRITE_TIMEOUT : PICORB_TRANSPORT_WRITE_FAILED;
      return -1;
    }
  }
}

/* Receive data.
 * If nonblock is true, uses MSG_DONTWAIT and returns
 * PICORB_RECV_WOULD_BLOCK when no data is available.
 * Otherwise uses a blocking recv() and returns as soon as any data
 * is available, or 0 on EOF, or -1 on error (readpartial semantics). */
ssize_t
TCPSocket_recv(picorb_state *vm, picorb_socket_t *sock, void *buf, size_t len, bool nonblock)
{
  if (!sock || !buf || sock->fd < 0 || sock->closed) {
    return -1;
  }

  if (nonblock) {
    ssize_t received = recv(sock->fd, buf, len, MSG_DONTWAIT);
    if (received < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK) {
        return PICORB_RECV_WOULD_BLOCK;
      }
      return -1;
    }
    if (received == 0) {
      sock->connected = false;
    }
    return received;
  }

  /* Return as soon as any data is available (readpartial semantics). */
  ssize_t received = recv(sock->fd, buf, len, 0);

  if (received < 0) {
    return -1;
  }
  if (received == 0) {
    sock->connected = false;
  }
  return received;
}

ssize_t
TCPSocket_recv_deadline(picorb_state *vm, picorb_socket_t *sock,
                        void *buf, size_t len, int64_t deadline_us)
{
  (void)vm;
  if (!sock || !buf || sock->fd < 0 || sock->closed || len > (size_t)SSIZE_MAX) {
    if (sock) sock->transport_error = PICORB_TRANSPORT_READ_FAILED;
    return -1;
  }
  while (true) {
    ssize_t received = recv(sock->fd, buf, len, MSG_DONTWAIT);
    if (received >= 0) {
      if (received == 0) sock->connected = false;
      return received;
    }
    if (errno == EINTR) continue;
    if (errno != EAGAIN && errno != EWOULDBLOCK) {
      sock->transport_error = PICORB_TRANSPORT_READ_FAILED;
      return -1;
    }
    int ready = wait_for_fd(sock->fd, POLLIN, deadline_us);
    if (ready <= 0) {
      sock->transport_error = ready == 0 ? PICORB_TRANSPORT_READ_TIMEOUT : PICORB_TRANSPORT_READ_FAILED;
      return -1;
    }
  }
}

int
TCPSocket_eof_probe(picorb_state *vm, picorb_socket_t *sock, int64_t deadline_us)
{
  (void)vm;
  unsigned char byte;
  while (true) {
    ssize_t received = recv(sock->fd, &byte, 1, MSG_PEEK | MSG_DONTWAIT);
    if (received > 0) return PICORB_PROBE_DATA;
    if (received == 0) return PICORB_PROBE_EOF;
    if (errno == EINTR) continue;
    if (errno != EAGAIN && errno != EWOULDBLOCK) {
      sock->transport_error = PICORB_TRANSPORT_READ_FAILED;
      return PICORB_PROBE_ERROR;
    }
    int ready = wait_for_fd(sock->fd, POLLIN, deadline_us);
    if (ready <= 0) {
      sock->transport_error = ready == 0 ? PICORB_TRANSPORT_READ_TIMEOUT : PICORB_TRANSPORT_READ_FAILED;
      return PICORB_PROBE_ERROR;
    }
  }
}

/* Check if data is ready to read */
bool
Socket_ready(picorb_state *vm, picorb_socket_t *sock)
{
  if (!sock || sock->fd < 0 || sock->closed) {
    return false;
  }

  int available = 0;
  if (ioctl(sock->fd, FIONREAD, &available) < 0) {
    return false;
  }

  return available > 0;
}

/* Close socket */
bool
TCPSocket_close(picorb_state *vm, picorb_socket_t *sock)
{
  if (!sock || sock->fd < 0) {
    return false;
  }

  close(sock->fd);
  sock->fd = -1;
  sock->connected = false;
  sock->closed = true;

  return true;
}

/* Get remote host */
const char*
TCPSocket_remote_host(picorb_state *vm, picorb_socket_t *sock)
{
  if (!sock) return NULL;
  return sock->remote_host;
}

/* Get remote port */
int
TCPSocket_remote_port(picorb_state *vm, picorb_socket_t *sock)
{
  if (!sock) return -1;
  return sock->remote_port;
}

/* Check if socket is closed */
bool
TCPSocket_closed(picorb_state *vm, picorb_socket_t *sock)
{
  if (!sock) return true;
  return sock->closed || sock->fd < 0;
}
