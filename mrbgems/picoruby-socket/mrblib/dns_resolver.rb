if Object.const_defined?(:SocketDNSResolver)
  class SocketDNSResolver
    def self.resolve_host(host, deadline = nil)
      new(host).resolve(deadline)
    end

    def resolve(deadline = nil)
      pending = true
      begin
        status = __status
        while status == 1
          timeout_ms = deadline ?
            BasicSocket.__remaining_timeout_ms(deadline, :dns_timeout) :
            BasicSocket::CONNECTION_TIMEOUT_MS
          unless @event_queue.pop(timeout_ms: timeout_ms)
            __abandon
            pending = false
            raise(deadline ? SocketTransportError.new(:dns_timeout) : SocketError.new('DNS resolution timed out'))
          end
          status = __status
        end
        address = __address
        __release
        pending = false
        return address if status == 2 && address
        raise(deadline ? SocketTransportError.new(:dns_failed) : SocketError.new('DNS resolution failed'))
      ensure
        __abandon if pending
      end
    end
  end
end
