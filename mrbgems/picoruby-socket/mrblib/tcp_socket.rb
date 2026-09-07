class TCPSocket < BasicSocket
  # TCPSocket is mostly implemented in C
  # This file provides additional Ruby-level methods

  if Object.const_defined?(:SocketDNSResolver)
    def initialize(host, port, deadline = nil)
      host = SocketDNSResolver.resolve_host(host, deadline)
      BasicSocket.__remaining_timeout_ms(deadline, :connect_timeout) if deadline
      __initialize_poll(host, port)
      event_queue = @event_queue
      return unless event_queue

      while __connection_state == 1
        if deadline
          timeout_ms = BasicSocket.__remaining_timeout_ms(deadline, :connect_timeout)
          unless event_queue.pop(timeout_ms: timeout_ms)
            close
            raise SocketTransportError.new(:connect_timeout)
          end
        else
          __wait_for_event(event_queue, "connection timed out")
        end
      end
      return if __connection_state == 2

      message = __error_message
      close
      raise SocketTransportError.new(:connect_failed) if deadline
      raise SocketError, message || "failed to connect"
    end
  end

  # Class methods

  def self.open(host, port)
    new(host, port)
  end

  if const_defined?(:TRANSPORT_DEADLINES)
    def self.__transport_open(host, port, deadline)
      new(host, port, deadline)
    end
  end

  def self.gethostbyname(host)
    # Simplified version - returns the host as-is
    # In a full implementation, this would do actual DNS resolution
    [host, [], 2, host]
  end

  # Instance methods

  def addr
    # Returns [address_family, port, hostname, numeric_address]
    # For local address (not yet implemented, returns placeholder)
    ["AF_INET", 0, "0.0.0.0", "0.0.0.0"]
  end

  def connected?
    !closed?
  end

  if Object.const_defined?(:SocketDNSResolver)
    def readpartial(maxlen)
      __readpartial_event_queue(maxlen, "read timeout")
    end
  end
end
