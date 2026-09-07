class NetHTTPFakeSocket
  attr_reader :read_calls, :write_calls, :close_calls, :max_read

  def initialize(chunks, probe = :eof, clock = nil, advance_us = 0)
    @chunks = chunks
    @probe = probe
    @clock = clock
    @advance_us = advance_us
    @read_calls = 0
    @write_calls = 0
    @close_calls = 0
    @max_read = 0
    @written = ''
    @closed = false
  end

  def readpartial(maxlen)
    @read_calls += 1
    @max_read = maxlen if maxlen > @max_read
    raise EOFError if @chunks.empty?
    chunk = @chunks.shift
    if chunk.bytesize > maxlen
      @chunks.unshift(chunk.byteslice(maxlen, chunk.bytesize - maxlen))
      chunk = chunk.byteslice(0, maxlen)
    end
    chunk
  end

  def __transport_read(maxlen, deadline)
    @clock.advance(@advance_us) if @clock
    readpartial(maxlen)
  end

  def __transport_write(buffer, offset, length, deadline)
    @write_calls += 1
    @clock.advance(@advance_us) if @clock
    amount = length > 2 ? 2 : length
    @written << (buffer.byteslice(offset, amount) || '')
    amount
  end

  def __transport_eof_probe(deadline)
    @probe
  end

  def written
    @written
  end

  def close
    @close_calls += 1
    @closed = true
  end

  def closed?
    @closed
  end
end

class NetHTTPZeroWriteSocket < NetHTTPFakeSocket
  def __transport_write(buffer, offset, length, deadline)
    @write_calls += 1
    0
  end
end

class NetHTTPFakeClock
  def initialize(now = 0)
    @now = now
  end

  def uptime_us
    @now
  end

  def advance(amount)
    @now += amount
  end
end

begin
  Net::HTTP
  module Net
    class HTTPInjectedClient < HTTP
      def inject_transport(socket, context)
        @socket = socket
        @started = true
        @transport_context = context
      end
    end

    class HTTPHelperDouble < HTTP
      def initialize(address, port = nil)
      end

      def start
        yield self if block_given?
        self
      end

      def get(path, headers = nil)
        HTTPResponse.new('299', 'Test', '1.1')
      end

      def request(request, body = nil)
        HTTPResponse.new('298', 'Test', '1.1')
      end
    end
  end
rescue NameError
end

class NetHTTPTransportTest < Picotest::Test
  def reader(raw, header_limit = nil, body_limit = nil, line_limit = nil, method = 'GET', split = 100)
    chunks = []
    offset = 0
    while offset < raw.bytesize
      chunks << (raw.byteslice(offset, split) || '')
      offset += split
    end
    socket = NetHTTPFakeSocket.new(chunks)
    [Net::HTTPResponseReader.new(socket, method, header_limit, body_limit, line_limit).read, socket]
  end

  def raised_error
    begin
      yield
      nil
    rescue => error
      error
    end
  end

  def test_class_helpers_return_responses
    assert_equal '299', Net::HTTPHelperDouble.get_response('example.com', '/').code
    assert_equal '298', Net::HTTPHelperDouble.post_form('http://example.com/', {'a' => 'b'}).code
  end

  def test_h01_content_length_across_reads
    response, socket = reader("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nHelloEXTRA", nil, 5, nil, 'GET', 1)
    assert_equal 'Hello', response.body
    assert_true socket.read_calls < 60
  end

  def test_h02_short_content_length_is_incomplete
    error = raised_error do
      reader("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nHi", 100, 10, 40, 'GET', 2)
    end
    assert_equal :incomplete_http_response, error.reason
    assert_equal :request_started, error.phase
  end

  def test_h03_header_limit_stops_before_extra_read
    raw = "HTTP/1.1 200 OK\r\nX-Long: abcdef\r\n\r\n"
    error = raised_error { reader(raw, 24, 10, 40, 'GET', 100) }
    assert_equal :response_header_too_large, error.reason
  end

  def test_h04_declared_body_over_limit_does_not_read_body
    raw = "HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nSECRET"
    socket = NetHTTPFakeSocket.new([raw.byteslice(0, 43), raw.byteslice(43, 6)])
    error = raised_error do
      Net::HTTPResponseReader.new(socket, 'GET', 100, 5, 50).read
    end
    assert_equal :response_body_too_large, error.reason
    assert_equal 1, socket.read_calls
  end

  def test_h05_positive_reads_refresh_idle_but_not_total
    clock = NetHTTPFakeClock.new
    context = Net::HTTPTransportContext.new(clock, 60, 3, nil, 10, nil, nil, nil)
    socket = NetHTTPFakeSocket.new(['a', 'b', 'c', 'd', 'e', 'f'], :eof, clock, 2_000_000)
    i = 0
    while i < 5
      assert_equal 1, context.read(socket, 1).bytesize
      i += 1
    end
    error = raised_error { context.read(socket, 1) }
    assert_equal :total_timeout, error.reason
    assert_equal 5, socket.read_calls
  end

  def test_h06_terminal_chunk_and_trailer_need_no_extra_read
    raw = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nHello\r\n0\r\nX-End: yes\r\n\r\n"
    response, socket = reader(raw, 200, 10, 100)
    assert_equal 'Hello', response.body
    assert_equal 1, socket.read_calls
  end

  def test_h07_chunked_every_byte_split
    raw = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2;foo=\"a\\b\"\r\nA\x00\r\n3\r\nB\r\n\r\n0\r\n\r\n"
    response, socket = reader(raw, 200, 5, 80, 'GET', 1)
    assert_equal "A\x00B\r\n", response.body
    assert_true socket.read_calls > 50
  end

  def test_h08_chunked_eof_before_zero_chunk
    raw = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\n"
    error = raised_error { reader(raw, 100, 10, 60, 'GET', 3) }
    assert_equal :incomplete_http_response, error.reason
  end

  def test_h09_invalid_and_overflow_chunk_sizes
    invalid = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nZ\r\n"
    error = raised_error { reader(invalid, 100, 10, 60) }
    assert_equal :invalid_http_response, error.reason
    overflow = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n8000000000000000\r\n"
    error = raised_error { reader(overflow, 120, 10, 60) }
    assert_equal :invalid_http_response, error.reason
  end

  def test_h10_conflicting_framing_is_rejected
    raw = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nTransfer-Encoding: chunked\r\n\r\n"
    error = raised_error { reader(raw, 120, 10, 80) }
    assert_equal :invalid_http_response, error.reason
    raw = "HTTP/1.1 200 OK\r\nContent-Length: 1, 2\r\n\r\na"
    error = raised_error { reader(raw, 100, 10, 80) }
    assert_equal :invalid_http_response, error.reason
  end

  def test_h11_close_delimited_and_exact_limit_probe
    response, _socket = reader("HTTP/1.1 200 OK\r\n\r\nabc", 80, 3, 40)
    assert_equal 'abc', response.body
    socket = NetHTTPFakeSocket.new(["HTTP/1.1 200 OK\r\n\r\nabc"], :extra_data)
    error = raised_error do
      Net::HTTPResponseReader.new(socket, 'GET', 80, 3, 40).read
    end
    assert_equal :response_body_too_large, error.reason
  end

  def test_h12_informational_limit
    prefix = ''
    i = 0
    while i < 8
      prefix << "HTTP/1.1 100 Continue\r\n\r\n"
      i += 1
    end
    response, _socket = reader(prefix + "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n", 300, 0, 40)
    assert_equal '200', response.code
    error = raised_error do
      reader("HTTP/1.1 100 Continue\r\n\r\n" + prefix + "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n", 400, 0, 40)
    end
    assert_equal :invalid_http_response, error.reason
  end

  def test_h13_redirect_is_returned_without_following
    response, socket = reader("HTTP/1.1 302 Found\r\nLocation: https://other.invalid/\r\nContent-Length: 0\r\n\r\n", 120, 0, 80)
    assert_true response.redirect?
    assert_equal 'https://other.invalid/', response['location']
    assert_equal 1, socket.read_calls
  end

  def test_h14_zero_write_is_finite_and_started
    clock = NetHTTPFakeClock.new
    context = Net::HTTPTransportContext.new(clock, 60, 60, 3, 10, nil, nil, nil)
    socket = NetHTTPZeroWriteSocket.new([])
    error = raised_error { context.write(socket, 'abc') }
    assert_equal :write_failed, error.reason
    assert_equal :request_started, error.phase
    assert_equal 1, socket.write_calls
  end

  def test_h15_wall_clock_changes_do_not_affect_deadlines
    monotonic = NetHTTPFakeClock.new(1_000_000)
    wall = NetHTTPFakeClock.new(1_000_000)
    context = Net::HTTPTransportContext.new(monotonic, 2, 2, nil, 3, nil, nil, nil)
    wall.advance(100_000_000)
    assert_true context.check!
    wall.advance(-200_000_000)
    monotonic.advance(3_000_000)
    error = raised_error { context.check! }
    assert_equal :total_timeout, error.reason
  end

  def test_h16_cleanup_preserves_the_transport_error
    i = 0
    while i < 3
      socket = NetHTTPFakeSocket.new([])
      http = Net::HTTPInjectedClient.new('example.com')
      http.inject_transport(socket, Net::HTTPTransportContext.new(
        NetHTTPFakeClock.new, 1, 1, 1, 2, 100, 10, 40
      ))
      error = raised_error { http.get('/') }
      assert_equal :incomplete_http_response, error.reason
      assert_equal :request_started, error.phase
      assert_equal 1, socket.close_calls
      assert_false http.active?
      i += 1
    end
  end

  def test_h17_request_limit_and_snapshot
    request = Net::Post.new('/submit', {'X-Key' => 'secret'})
    request.body = 'first'
    request.set_default_headers('example.com', 443)
    snapshot = request.transport_snapshot(nil)
    exact = snapshot[-1]
    request.body = 'other'
    wire = Net::HTTPGenericRequest.serialize_snapshot(snapshot)
    assert_true wire.end_with?('first')
    assert_equal exact, wire.bytesize
    error = raised_error { request.transport_snapshot(exact - 1) }
    assert_equal :request_too_large, error.reason
    assert_equal :before_request, error.phase
    assert_false error.message.include?('secret')
  end

  def test_h18_unsupported_content_encoding
    raw = "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 3\r\n\r\nZIP"
    error = raised_error { reader(raw, 120, 10, 80) }
    assert_equal :unsupported_content_encoding, error.reason
  end

  def test_response_syntax_and_binary_body_boundaries
    invalid = [
      "HTTP/2 200 OK\r\n\r\n",
      "HTTP/1.1 20 OK\r\n\r\n",
      "HTTP/1.1 200 OK\n\n",
      "HTTP/1.1 200 OK\r\n Bad: value\r\n\r\n",
      "HTTP/1.1 200 OK\r\nBad : value\r\n\r\n",
      "HTTP/1.1 200 OK\r\nX: a\x00b\r\n\r\n",
      "HTTP/1.1 200 OK\r\nContent-Length: 1,\r\n\r\na"
    ]
    i = 0
    while i < invalid.size
      error = raised_error { reader(invalid[i], 100, 20, 40) }
      assert_equal :invalid_http_response, error.reason
      i += 1
    end
    body = "x\r\n\x00\xff"
    raw = "HTTP/1.1 200 \r\nContent-Length: #{body.bytesize}\r\n\r\n" + body
    response, _socket = reader(raw, 100, body.bytesize, 40, 'GET', 2)
    assert_equal body, response.body
  end

  def test_line_header_and_body_exact_limits
    raw = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"
    response, _socket = reader(raw, raw.bytesize, 0, 19, 'GET', 1)
    assert_equal '', response.body
    error = raised_error { reader(raw, raw.bytesize - 1, 0, 19, 'GET', 1) }
    assert_equal :response_header_too_large, error.reason
    error = raised_error { reader(raw, raw.bytesize, 0, 18, 'GET', 1) }
    assert_equal :response_line_too_large, error.reason
  end

  def test_no_body_statuses_do_not_read_payload
    raw = "HTTP/1.1 304 Not Modified\r\nContent-Length: 50\r\n\r\n"
    response, socket = reader(raw, 100, 0, 50)
    assert_nil response.body
    assert_equal 1, socket.read_calls
    error = raised_error do
      reader("HTTP/1.1 304 Not Modified\r\nContent-Length: bad\r\n\r\n", 100, 0, 50)
    end
    assert_equal :invalid_http_response, error.reason
    raw = "HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\n"
    response, socket = reader(raw, 100, 0, 50, 'HEAD')
    assert_nil response.body
    assert_equal 1, socket.read_calls
  end

  def test_transport_configuration_validation
    http = Net::HTTP.new('example.com')
    assert_equal 60, http.open_timeout
    assert_equal 60, http.read_timeout
    assert_nil http.write_timeout
    assert_nil http.total_timeout
    http.max_response_body_bytes = 0
    assert_equal 0, http.max_response_body_bytes
    invalid = [0, -1, 0.0000001, '1']
    i = 0
    while i < invalid.size
      error = raised_error { http.total_timeout = invalid[i] }
      assert_equal :invalid_transport_configuration, error.reason
      i += 1
    end
    error = raised_error { http.max_request_bytes = -1 }
    assert_equal :invalid_transport_configuration, error.reason
    legacy = Net::HTTPTransportContext.new(nil, 60, 60, nil, nil, nil, nil, nil)
    assert_true legacy.check!
    unless TCPSocket.const_defined?(:TRANSPORT_DEADLINES)
      http.max_request_bytes = 2048
      error = raised_error { http.get('/') }
      assert_equal :unsupported_transport, error.reason
      assert_equal :before_request, error.phase
    end
  end

  def test_request_syntax_validation
    request = Net::Get.new("/ok\r\nInjected: yes")
    request.set_default_headers('example.com', 80)
    error = raised_error { request.transport_snapshot(1000) }
    assert_equal :invalid_http_request, error.reason
    request = Net::Get.new('/')
    request['bad header'] = 'value'
    request.set_default_headers('example.com', 80)
    error = raised_error { request.transport_snapshot(1000) }
    assert_equal :invalid_http_request, error.reason
  end
end
