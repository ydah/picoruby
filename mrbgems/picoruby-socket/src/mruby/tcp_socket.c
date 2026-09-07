#include <stdlib.h>
#include <string.h>
#include "mruby/presym.h"
#include "mruby/string.h"
#include "mruby/class.h"
#include "mruby/data.h"
#include "mruby/variable.h"
#ifdef PICO_CYW43_ARCH_POLL
#include "task.h"
#endif

#define E_SOCKET_ERROR (mrb_class_get_id(mrb, MRB_SYM(SocketError)))
#define E_EOF_ERROR    (mrb_class_get_id(mrb, MRB_SYM(EOFError)))
#if defined(PICORB_PLATFORM_POSIX) || defined(PICO_CYW43_ARCH_POLL)
#define PICORB_TRANSPORT_DEADLINES 1
#endif

/* TCPSocket.new(host, port) */
static mrb_value
mrb_tcp_socket_initialize(mrb_state *mrb, mrb_value self)
{
  const char *host;
  mrb_int port;
  mrb_int deadline_us = 0;

#ifdef PICORB_TRANSPORT_DEADLINES
  mrb_get_args(mrb, "zi|i", &host, &port, &deadline_us);
#else
  mrb_get_args(mrb, "zi", &host, &port);
#endif

  if (port < 0 || 65535 < port) {
    mrb_raisef(mrb, E_ARGUMENT_ERROR, "invalid port number: %i", port);
  }

  /* Allocate socket structure */
  picorb_socket_t *sock = (picorb_socket_t *)mrb_malloc(mrb, sizeof(picorb_socket_t));
  if (!sock) {
    mrb_raise(mrb, E_RUNTIME_ERROR, "failed to allocate socket");
  }

  /* Create socket */
  if (!TCPSocket_create(mrb, sock)) {
    mrb_free(mrb, sock);
    mrb_raise(mrb, E_RUNTIME_ERROR, "failed to create socket");
  }

  mrb_data_init(self, sock, &mrb_socket_type);

#ifdef PICO_CYW43_ARCH_POLL
  picorb_socket_attach_event_queue(mrb, &self, sock);
#endif

  /* Connect to remote host. RP2040 poll mode returns after starting the
   * connection; Ruby waits on event_queue and checks __connection_state. */
#ifdef PICORB_TRANSPORT_DEADLINES
  bool connected = TCPSocket_connect_deadline(mrb, sock, host, (int)port, (int64_t)deadline_us);
#else
  bool connected = TCPSocket_connect(mrb, sock, host, (int)port);
#endif
  if (!connected) {
#ifdef PICORB_TRANSPORT_DEADLINES
    if (deadline_us > 0) {
      picorb_raise_transport_error(mrb, sock->transport_error);
    }
#endif
    mrb_raisef(mrb, E_SOCKET_ERROR, "%s",
      sock->errmsg[0] ? sock->errmsg : "failed to connect");
  }

  return self;
}

#ifdef PICORB_TRANSPORT_DEADLINES
static int64_t
mrb_transport_deadline(mrb_state *mrb, mrb_value value)
{
  if (mrb_nil_p(value)) return 0;
  if (!mrb_integer_p(value)) mrb_raise(mrb, E_ARGUMENT_ERROR, "deadline must be an Integer or nil");
  mrb_int deadline = mrb_integer(value);
  if (deadline < 0) mrb_raise(mrb, E_ARGUMENT_ERROR, "deadline must not be negative");
  return (int64_t)deadline;
}

static mrb_value
mrb_tcp_socket_transport_write(mrb_state *mrb, mrb_value self)
{
  picorb_socket_t *sock = (picorb_socket_t *)mrb_data_get_ptr(mrb, self, &mrb_socket_type);
  mrb_value data, deadline_value;
  mrb_int offset, length;
  mrb_get_args(mrb, "Siio", &data, &offset, &length, &deadline_value);
  if (!sock || offset < 0 || length < 0 || offset > RSTRING_LEN(data) ||
      length > RSTRING_LEN(data) - offset) {
    mrb_raise(mrb, E_ARGUMENT_ERROR, "invalid transport write range");
  }
  ssize_t sent = TCPSocket_send_deadline(
    mrb, sock, RSTRING_PTR(data) + offset, (size_t)length,
    mrb_transport_deadline(mrb, deadline_value));
  if (sent == PICORB_SEND_WOULD_BLOCK) return mrb_nil_value();
  if (sent < 0) picorb_raise_transport_error(mrb, sock->transport_error);
  return mrb_fixnum_value((mrb_int)sent);
}

static mrb_value
mrb_tcp_socket_transport_read(mrb_state *mrb, mrb_value self)
{
  picorb_socket_t *sock = (picorb_socket_t *)mrb_data_get_ptr(mrb, self, &mrb_socket_type);
  mrb_int maxlen;
  mrb_value deadline_value;
  mrb_get_args(mrb, "io", &maxlen, &deadline_value);
  if (!sock || maxlen <= 0) mrb_raise(mrb, E_ARGUMENT_ERROR, "maxlen must be positive");
  char stack_buf[PICORB_SOCKET_STACK_BUF_SIZE];
  char *read_buf = maxlen < PICORB_SOCKET_STACK_BUF_SIZE ? stack_buf : (char *)mrb_malloc(mrb, (size_t)maxlen);
  ssize_t received = TCPSocket_recv_deadline(
    mrb, sock, read_buf, (size_t)maxlen, mrb_transport_deadline(mrb, deadline_value));
  if (received == PICORB_RECV_WOULD_BLOCK) {
    if (read_buf != stack_buf) mrb_free(mrb, read_buf);
    return mrb_nil_value();
  }
  if (received == 0) {
    if (read_buf != stack_buf) mrb_free(mrb, read_buf);
    mrb_raise(mrb, E_EOF_ERROR, "end of file reached");
  }
  if (received < 0) {
    if (read_buf != stack_buf) mrb_free(mrb, read_buf);
    picorb_raise_transport_error(mrb, sock->transport_error);
  }
  mrb_value result = mrb_str_new(mrb, read_buf, received);
  if (read_buf != stack_buf) mrb_free(mrb, read_buf);
  return result;
}

static mrb_value
mrb_tcp_socket_transport_eof_probe(mrb_state *mrb, mrb_value self)
{
  picorb_socket_t *sock = (picorb_socket_t *)mrb_data_get_ptr(mrb, self, &mrb_socket_type);
  mrb_value deadline_value;
  mrb_get_args(mrb, "o", &deadline_value);
  if (!sock) mrb_raise(mrb, E_RUNTIME_ERROR, "socket is not initialized");
  int result = TCPSocket_eof_probe(mrb, sock, mrb_transport_deadline(mrb, deadline_value));
  if (result == PICORB_PROBE_ERROR) picorb_raise_transport_error(mrb, sock->transport_error);
  return mrb_fixnum_value(result);
}
#endif

static mrb_value
mrb_tcp_socket_connection_state(mrb_state *mrb, mrb_value self)
{
  picorb_socket_t *sock;
  sock = (picorb_socket_t *)mrb_data_get_ptr(mrb, self, &mrb_socket_type);
  if (!sock) {
    mrb_raise(mrb, E_RUNTIME_ERROR, "socket is not initialized");
  }
  return mrb_fixnum_value(TCPSocket_connection_state(mrb, sock));
}

static mrb_value
mrb_tcp_socket_error_message(mrb_state *mrb, mrb_value self)
{
  picorb_socket_t *sock;
  sock = (picorb_socket_t *)mrb_data_get_ptr(mrb, self, &mrb_socket_type);
  if (!sock || !sock->errmsg[0]) return mrb_nil_value();
  return mrb_str_new_cstr(mrb, sock->errmsg);
}

/* socket.send(data, flags) */
static mrb_value
mrb_tcp_socket_send(mrb_state *mrb, mrb_value self)
{
  picorb_socket_t *sock;
  mrb_value data;
  // flags is required parameter for compatibility with CRuby.
  // Currently check only if it's an Integer. It can be used for future extensions
  mrb_int flags;

  sock = (picorb_socket_t *)mrb_data_get_ptr(mrb, self, &mrb_socket_type);
  if (!sock) {
    mrb_raise(mrb, E_RUNTIME_ERROR, "socket is not initialized");
  }

  mrb_get_args(mrb, "Si", &data, &flags);
  (void)flags; // Unused for now

  ssize_t sent = TCPSocket_send(mrb, sock, RSTRING_PTR(data), RSTRING_LEN(data));
  if (sent < 0) {
    mrb_raise(mrb, E_RUNTIME_ERROR, "send failed");
  }

  return mrb_fixnum_value(sent);
}

/* socket.readpartial(maxlen) */
static mrb_value
mrb_tcp_socket_readpartial(mrb_state *mrb, mrb_value self)
{
  picorb_socket_t *sock;
  mrb_int maxlen;
  mrb_value buf;

  sock = (picorb_socket_t *)mrb_data_get_ptr(mrb, self, &mrb_socket_type);
  if (!sock) {
    mrb_raise(mrb, E_RUNTIME_ERROR, "socket is not initialized");
  }

  mrb_get_args(mrb, "i", &maxlen);

  if (maxlen <= 0) {
    mrb_raise(mrb, E_ARGUMENT_ERROR, "maxlen must be positive");
  }

  char stack_buf[PICORB_SOCKET_STACK_BUF_SIZE];
  char *read_buf = (maxlen < PICORB_SOCKET_STACK_BUF_SIZE)
    ? stack_buf
    : (char *)mrb_malloc(mrb, maxlen);
  if (!read_buf) {
    mrb_raise(mrb, E_RUNTIME_ERROR, "failed to allocate buffer");
  }

  ssize_t received = TCPSocket_recv(mrb, sock, read_buf, maxlen, false);

  if (received == 0) {
    if (read_buf != stack_buf) mrb_free(mrb, read_buf);
    mrb_raise(mrb, E_EOF_ERROR, "end of file reached");
  }

  if (received == PICORB_RECV_TIMEOUT) {
    if (read_buf != stack_buf) mrb_free(mrb, read_buf);
    mrb_raise(mrb, E_SOCKET_ERROR, "read timeout");
  }

  if (received < 0) {
    if (read_buf != stack_buf) mrb_free(mrb, read_buf);
    mrb_raise(mrb, E_RUNTIME_ERROR, "read failed");
  }

  buf = mrb_str_new(mrb, read_buf, received);
  if (read_buf != stack_buf) mrb_free(mrb, read_buf);

  return buf;
}

/* socket.read_nonblock(maxlen) */
static mrb_value
mrb_tcp_socket_read_nonblock(mrb_state *mrb, mrb_value self)
{
  picorb_socket_t *sock;
  mrb_int maxlen;
  mrb_value buf;

  sock = (picorb_socket_t *)mrb_data_get_ptr(mrb, self, &mrb_socket_type);
  if (!sock) {
    mrb_raise(mrb, E_RUNTIME_ERROR, "socket is not initialized");
  }

  mrb_get_args(mrb, "i", &maxlen);

  if (maxlen <= 0) {
    mrb_raise(mrb, E_ARGUMENT_ERROR, "maxlen must be positive");
  }

  char stack_buf[PICORB_SOCKET_STACK_BUF_SIZE];
  char *read_buf = (maxlen < PICORB_SOCKET_STACK_BUF_SIZE)
    ? stack_buf
    : (char *)mrb_malloc(mrb, maxlen);
  if (!read_buf) {
    mrb_raise(mrb, E_RUNTIME_ERROR, "failed to allocate buffer");
  }

  ssize_t received = TCPSocket_recv(mrb, sock, read_buf, maxlen, true);

  if (received == PICORB_RECV_WOULD_BLOCK) {
#ifdef PICO_CYW43_ARCH_POLL
    sock->event_pending = false;
#endif
    if (read_buf != stack_buf) mrb_free(mrb, read_buf);
    return mrb_nil_value();
  }

  if (received == 0) {
    if (read_buf != stack_buf) mrb_free(mrb, read_buf);
    mrb_raise(mrb, E_EOF_ERROR, "end of file reached");
  }

  if (received < 0) {
    if (read_buf != stack_buf) mrb_free(mrb, read_buf);
    mrb_raise(mrb, E_RUNTIME_ERROR, "read failed");
  }

  buf = mrb_str_new(mrb, read_buf, received);
  if (read_buf != stack_buf) mrb_free(mrb, read_buf);

  return buf;
}

/* socket.close */
static mrb_value
mrb_tcp_socket_close(mrb_state *mrb, mrb_value self)
{
  picorb_socket_t *sock;

  sock = (picorb_socket_t *)mrb_data_get_ptr(mrb, self, &mrb_socket_type);
  if (!sock) {
    mrb_raise(mrb, E_RUNTIME_ERROR, "socket is not initialized");
  }

  if (!TCPSocket_close(mrb, sock)) {
    mrb_raise(mrb, E_RUNTIME_ERROR, "close failed");
  }

  return mrb_nil_value();
}

/* socket.closed? */
static mrb_value
mrb_tcp_socket_closed_p(mrb_state *mrb, mrb_value self)
{
  picorb_socket_t *sock;

  sock = (picorb_socket_t *)mrb_data_get_ptr(mrb, self, &mrb_socket_type);
  if (!sock) {
    return mrb_true_value();
  }

  return mrb_bool_value(TCPSocket_closed(mrb, sock));
}

/* socket.remote_host */
static mrb_value
mrb_tcp_socket_remote_host(mrb_state *mrb, mrb_value self)
{
  picorb_socket_t *sock;

  sock = (picorb_socket_t *)mrb_data_get_ptr(mrb, self, &mrb_socket_type);
  if (!sock) {
    mrb_raise(mrb, E_RUNTIME_ERROR, "socket is not initialized");
  }

  const char *host = TCPSocket_remote_host(mrb, sock);
  if (!host) {
    return mrb_nil_value();
  }

  return mrb_str_new_cstr(mrb, host);
}

/* socket.remote_port */
static mrb_value
mrb_tcp_socket_remote_port(mrb_state *mrb, mrb_value self)
{
  picorb_socket_t *sock;

  sock = (picorb_socket_t *)mrb_data_get_ptr(mrb, self, &mrb_socket_type);
  if (!sock) {
    mrb_raise(mrb, E_RUNTIME_ERROR, "socket is not initialized");
  }

  int port = TCPSocket_remote_port(mrb, sock);
  if (port < 0) {
    return mrb_nil_value();
  }

  return mrb_fixnum_value(port);
}

/* socket.ready? */
static mrb_value
mrb_tcp_socket_ready_p(mrb_state *mrb, mrb_value self)
{
  picorb_socket_t *sock;

  sock = (picorb_socket_t *)mrb_data_get_ptr(mrb, self, &mrb_socket_type);
  if (!sock) {
    return mrb_false_value();
  }

  return mrb_bool_value(Socket_ready(mrb, sock));
}

void
tcp_socket_init(mrb_state *mrb, struct RClass *basic_socket_class)
{
  struct RClass *tcp_socket_class;

  tcp_socket_class = mrb_define_class_id(mrb, MRB_SYM(TCPSocket), basic_socket_class);
  MRB_SET_INSTANCE_TT(tcp_socket_class, MRB_TT_DATA);
#ifdef PICORB_TRANSPORT_DEADLINES
  mrb_define_const(mrb, tcp_socket_class, "TRANSPORT_DEADLINES", mrb_true_value());
#endif

#ifdef PICO_CYW43_ARCH_POLL
  mrb_define_private_method_id(mrb, tcp_socket_class, MRB_SYM(__initialize_poll), mrb_tcp_socket_initialize, MRB_ARGS_ARG(2, 1));
  mrb_define_private_method_id(mrb, tcp_socket_class, MRB_SYM(__connection_state), mrb_tcp_socket_connection_state, MRB_ARGS_NONE());
  mrb_define_private_method_id(mrb, tcp_socket_class, MRB_SYM(__error_message), mrb_tcp_socket_error_message, MRB_ARGS_NONE());
  mrb_define_private_method_id(mrb, tcp_socket_class, MRB_SYM(__readpartial_poll), mrb_tcp_socket_readpartial, MRB_ARGS_REQ(1));
#else
  mrb_define_method_id(mrb, tcp_socket_class, MRB_SYM(initialize), mrb_tcp_socket_initialize, MRB_ARGS_ARG(2, 1));
  mrb_define_method_id(mrb, tcp_socket_class, MRB_SYM(readpartial), mrb_tcp_socket_readpartial, MRB_ARGS_REQ(1));
#endif
#ifdef PICORB_TRANSPORT_DEADLINES
  mrb_define_method_id(mrb, tcp_socket_class,
#ifdef PICO_CYW43_ARCH_POLL
                               mrb_intern_lit(mrb, "__transport_write_poll"),
#else
                               mrb_intern_lit(mrb, "__transport_write"),
#endif
                               mrb_tcp_socket_transport_write, MRB_ARGS_REQ(4));
#ifdef PICO_CYW43_ARCH_POLL
  mrb_define_private_method_id(mrb, tcp_socket_class, mrb_intern_lit(mrb, "__transport_read_poll"),
                               mrb_tcp_socket_transport_read, MRB_ARGS_REQ(2));
  mrb_define_private_method_id(mrb, tcp_socket_class, mrb_intern_lit(mrb, "__transport_eof_probe_poll"),
                               mrb_tcp_socket_transport_eof_probe, MRB_ARGS_REQ(1));
#else
  mrb_define_method_id(mrb, tcp_socket_class, mrb_intern_lit(mrb, "__transport_read"),
                               mrb_tcp_socket_transport_read, MRB_ARGS_REQ(2));
  mrb_define_method_id(mrb, tcp_socket_class, mrb_intern_lit(mrb, "__transport_eof_probe"),
                               mrb_tcp_socket_transport_eof_probe, MRB_ARGS_REQ(1));
#endif
#endif
  mrb_define_method_id(mrb, tcp_socket_class, MRB_SYM(send), mrb_tcp_socket_send, MRB_ARGS_REQ(2));
  mrb_define_method_id(mrb, tcp_socket_class, MRB_SYM(read_nonblock), mrb_tcp_socket_read_nonblock, MRB_ARGS_REQ(1));
  mrb_define_method_id(mrb, tcp_socket_class, MRB_SYM(close), mrb_tcp_socket_close, MRB_ARGS_NONE());
  mrb_define_method_id(mrb, tcp_socket_class, MRB_SYM_Q(closed), mrb_tcp_socket_closed_p, MRB_ARGS_NONE());
  mrb_define_method_id(mrb, tcp_socket_class, MRB_SYM_Q(ready), mrb_tcp_socket_ready_p, MRB_ARGS_NONE());
  mrb_define_method_id(mrb, tcp_socket_class, MRB_SYM(remote_host), mrb_tcp_socket_remote_host, MRB_ARGS_NONE());
  mrb_define_method_id(mrb, tcp_socket_class, MRB_SYM(remote_port), mrb_tcp_socket_remote_port, MRB_ARGS_NONE());
}
