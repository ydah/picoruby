class NetHTTPMemoryClock
  def initialize
    @now = 0
  end

  def uptime_us
    @now
  end

  def advance(amount)
    @now += amount
  end
end

class NetHTTPMemorySocket
  attr_reader :written, :write_calls, :close_calls

  def initialize(events, response, write_size = 1024)
    @events = events
    @response = response
    @write_size = write_size
    @written = ''
    @write_calls = 0
    @close_calls = 0
    @closed = false
  end

  def __transport_write(buffer, offset, length, deadline)
    @events << :write
    @write_calls += 1
    amount = length < @write_size ? length : @write_size
    @written << (buffer.byteslice(offset, amount) || '')
    amount
  end

  def __transport_read(maxlen, deadline)
    raise EOFError if @response.empty?
    amount = @response.bytesize < maxlen ? @response.bytesize : maxlen
    data = @response.byteslice(0, amount) || ''
    @response = @response.byteslice(amount, @response.bytesize - amount) || ''
    data
  end

  def __transport_eof_probe(deadline)
    @response.empty? ? :eof : :extra_data
  end

  def close
    @close_calls += 1
    @closed = true
  end

  def closed?
    @closed
  end
end

begin
  Net::HTTP
  module Net
    class HTTPMemoryRequest < Post
      def initialize(events, path = '/')
        @events = events
        super(path)
      end

      def transport_snapshot(limit)
        @events << :snapshot
        super(limit)
      end
    end

    class HTTPSerializationPoison
      def to_s
        raise NoMemoryError, 'injected allocation failure'
      end
    end

    class HTTPPoisonRequest < Get
      def initialize(events)
        @events = events
        super('/')
      end

      def transport_snapshot(limit)
        @events << :snapshot
        [HTTPSerializationPoison.new, '/', '', 0]
      end
    end

    class HTTPMismatchedRequest < Get
      def transport_snapshot(limit)
        snapshot = super(limit)
        snapshot[-1] += 1
        snapshot
      end
    end

    class HTTPMemoryClient < HTTP
      def prepare(socket, events, source = nil, error = nil, clock = nil, advance = 0)
        @memory_socket = socket
        @memory_events = events
        @memory_source = source
        @memory_error = error
        @memory_clock = clock
        @memory_advance = advance
        @transport_clock = clock if clock
      end

      private

      def transport_deadlines?
        true
      end

      def connect(context)
        @memory_events << :connect
        if @memory_source
          @memory_source.body = 'changed-length'
          @memory_source['x-key'] = 'changed'
        end
        @socket = @memory_socket
        @started = true
        @transport_context = context
        @memory_clock.advance(@memory_advance) if @memory_clock && @memory_advance > 0
        raise @memory_error if @memory_error
      end
    end

    class HTTPOOMClient < HTTPMemoryClient
      private

      def serialize_request(snapshot)
        raise NoMemoryError, 'injected allocation failure'
      end
    end
  end
rescue NameError
end

class NetHTTPMemoryLifecycleTest < Picotest::Test
  RESPONSE = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK"

  def raised_error
    begin
      yield
      nil
    rescue => error
      error
    end
  end

  def prepared_client(events, socket, source = nil, error = nil, clock = nil, advance = 0)
    clock ||= NetHTTPMemoryClock.new
    http = Net::HTTPMemoryClient.new('example.com', 443)
    http.max_request_bytes = 2048
    http.prepare(socket, events, source, error, clock, advance)
    http
  end

  def test_m01_snapshot_connect_and_write_order
    events = []
    request = Net::HTTPMemoryRequest.new(events)
    request.body = 'body'
    socket = NetHTTPMemorySocket.new(events, RESPONSE)
    response = prepared_client(events, socket).request(request)
    assert_equal [:snapshot, :connect, :write], events
    assert_equal 'OK', response.body
  end

  def test_m02_dns_wait_mutation_does_not_change_snapshot
    events = []
    request = Net::HTTPMemoryRequest.new(events)
    request.body = 'first'
    request['x-key'] = 'original'
    socket = NetHTTPMemorySocket.new(events, RESPONSE)
    prepared_client(events, socket, request).request(request)
    assert_true socket.written.end_with?('first')
    assert_true socket.written.include?("X-Key: original\r\n")
    assert_true socket.written.include?("Content-Length: 5\r\n")
  end

  def test_m03_exact_request_limit_and_preconnect_rejection
    sizing = Net::Post.new('/')
    sizing['x-pad'] = ''
    sizing.set_default_headers('example.com', 443)
    base = sizing.transport_snapshot(nil)[-1]
    padding = 'x' * (2048 - base)

    events = []
    request = Net::HTTPMemoryRequest.new(events)
    request['x-pad'] = padding
    socket = NetHTTPMemorySocket.new(events, RESPONSE)
    prepared_client(events, socket).request(request)
    assert_equal 2048, socket.written.bytesize

    events = []
    request = Net::HTTPMemoryRequest.new(events)
    request['x-pad'] = padding + 'x'
    socket = NetHTTPMemorySocket.new(events, RESPONSE)
    error = raised_error { prepared_client(events, socket).request(request) }
    assert_equal :request_too_large, error.reason
    assert_equal [:snapshot], events
    assert_equal 0, socket.write_calls
  end

  def test_m04_tls_failure_prevents_serialization_and_cleans_up
    events = []
    request = Net::HTTPPoisonRequest.new(events)
    socket = NetHTTPMemorySocket.new(events, RESPONSE)
    failure = Net::HTTPTransportError.new(:tls_verification_failed, :before_request)
    error = raised_error { prepared_client(events, socket, nil, failure).request(request) }
    assert_equal :tls_verification_failed, error.reason
    assert_equal [:snapshot, :connect], events
    assert_equal 1, socket.close_calls
  end

  def test_m05_serialization_failures_are_prewrite_and_cleanup
    events = []
    socket = NetHTTPMemorySocket.new(events, RESPONSE)
    error = raised_error do
      prepared_client(events, socket).request(Net::HTTPMismatchedRequest.new('/'))
    end
    assert_equal :request_serialization_failed, error.reason
    assert_equal :before_request, error.phase
    assert_equal 0, socket.write_calls
    assert_equal 1, socket.close_calls

    events = []
    socket = NetHTTPMemorySocket.new(events, RESPONSE)
    http = Net::HTTPOOMClient.new('example.com', 443)
    http.max_request_bytes = 2048
    http.prepare(socket, events, nil, nil, NetHTTPMemoryClock.new)
    error = raised_error { http.request(Net::Get.new('/')) }
    assert_equal :resource_exhausted, error.reason
    assert_equal :before_request, error.phase
    assert_equal 0, socket.write_calls
    assert_equal 1, socket.close_calls
  end

  def test_m06_partial_write_finishes_before_response
    events = []
    request = Net::HTTPMemoryRequest.new(events)
    request.body = 'payload'
    socket = NetHTTPMemorySocket.new(events, RESPONSE, 2)
    response = prepared_client(events, socket).request(request)
    assert_equal 'OK', response.body
    assert_true socket.write_calls > 1
    assert_true socket.written.end_with?('payload')
    assert_equal 1, socket.close_calls
  end
end
