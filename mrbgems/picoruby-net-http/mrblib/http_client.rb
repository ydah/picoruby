require 'socket'
require 'uri'

module Net
  # --------------------------------------------------------------------------
  # HTTP - Main HTTP client class
  # --------------------------------------------------------------------------
  class HTTP
    MAX_TRANSPORT_INTEGER = 0x7fffffffffffffff

    attr_accessor :address, :port
    attr_reader :open_timeout, :read_timeout, :write_timeout, :total_timeout
    attr_reader :max_request_bytes, :max_response_header_bytes
    attr_reader :max_response_body_bytes, :max_response_line_bytes
    attr_accessor :use_ssl, :verify_mode, :ca_file, :ca_path
    attr_reader :started

    # Create new HTTP client
    def initialize(address, port = nil)
      @address = address
      @port = port || 80
      @socket = nil
      @started = false
      @use_ssl = false
      @verify_mode = nil
      @ca_file = nil
      @ca_path = nil
      @open_timeout = 60
      @read_timeout = 60
      @write_timeout = nil
      @total_timeout = nil
      @max_request_bytes = nil
      @max_response_header_bytes = nil
      @max_response_body_bytes = nil
      @max_response_line_bytes = nil
      @transport_context = nil
      @transport_clock = Machine
    end

    def open_timeout=(value)
      validate_timeout(value)
      @open_timeout = value
    end

    def read_timeout=(value)
      validate_timeout(value)
      @read_timeout = value
    end

    def write_timeout=(value)
      validate_timeout(value) unless value.nil?
      @write_timeout = value
    end

    def total_timeout=(value)
      validate_timeout(value) unless value.nil?
      @total_timeout = value
    end

    def max_request_bytes=(value)
      @max_request_bytes = validate_size(value)
    end

    def max_response_header_bytes=(value)
      @max_response_header_bytes = validate_size(value)
    end

    def max_response_body_bytes=(value)
      @max_response_body_bytes = validate_size(value)
    end

    def max_response_line_bytes=(value)
      @max_response_line_bytes = validate_size(value)
    end

    # Start HTTP session
    def start
      raise IOError, "HTTP session already started" if @started
      context = new_transport_context
      connect(context)
      @transport_context = context

      # If block given, yield self and ensure finish
      if block_given?
        begin
          yield self
        ensure
          finish
        end
      end

      self
    end

    # Finish HTTP session
    def finish
      socket = @socket
      @socket = nil
      @started = false
      @transport_context = nil
      return nil unless socket
      begin
        socket.close unless socket.closed?
      rescue
        # State is cleared first so cleanup can never retain a broken socket.
      end
      nil
    end

    # Check if session is active
    def active?
      @started && @socket && !@socket.closed?
    end

    # Send GET request
    if RUBY_ENGINE == 'mruby'
      def get(path, initheader = nil, dest = nil, &block)
        request(Get.new(path, initheader), &block)
      end
    else # mruby/c
      def get(path, initheader = nil, dest = nil, &block)
        if self.class? # picoruby-metaprog
          # @type var initheader: String
          res = Net::HTTP._get(path, initheader, dest)
          # @type var res: Net::HTTPResponse
          return res # Truth: It's a String
        end
        request(Get.new(path, initheader), &block)
      end
    end

    # Send HEAD request
    def head(path, initheader = nil)
      request(Head.new(path, initheader))
    end

    # Send POST request
    def post(path, data, initheader = nil, dest = nil, &block)
      req = Post.new(path, initheader)
      req.body = data
      request(req, &block)
    end

    # Send PUT request
    def put(path, data, initheader = nil, dest = nil, &block)
      req = Put.new(path, initheader)
      req.body = data
      request(req, &block)
    end

    # Send DELETE request
    def delete(path, initheader = nil, dest = nil, &block)
      request(Delete.new(path, initheader), &block)
    end

    # Send generic HTTP request
    def request(req, body = nil, &block)
      raise ArgumentError, "Request must be an HTTPRequest" unless req.is_a?(HTTPGenericRequest)
      snapshot = nil
      begin
        req.body = body unless body.nil?
        req.set_default_headers(@address, @port)
        snapshot = req.transport_snapshot(@max_request_bytes)
        implicit = !@started
        context = @transport_context
        context = new_transport_context unless context
        connect(context) if implicit
        context.check!(:before_request)
        wire = serialize_request(snapshot)
        snapshot = nil
        context.check!(:before_request)
        context.write(@socket, wire)
        wire = nil
        response = HTTPResponseReader.new(
          @socket,
          req.method,
          context.max_response_header_bytes,
          context.max_response_body_bytes,
          context.max_response_line_bytes,
          context
        ).read
        @transport_context = nil
        yield response.body if block && response.body
        finish if implicit && bounded_transport?
        response
      rescue NoMemoryError
        finish
        raise HTTPRequestError.new(:resource_exhausted, :before_request)
      rescue => error
        finish
        raise error
      ensure
        snapshot = nil
      end
    end

    # Class method: Simple GET request
    # Note: Renamed from 'get' to avoid mruby/c limitation where class methods
    # and instance methods cannot have the same name
    def self._get(host, path, port = nil)
      if path.nil?
        raise ArgumentError, "Path cannot be nil"
      end
      if host.start_with?('http')
        # Parse URI
        uri = URI.parse(host)
        host = uri.host
        port ||= uri.port
        use_ssl = uri.scheme == 'https'
      else
        port ||= 80
        use_ssl = false
      end

      http = new(host, port)
      http.use_ssl = use_ssl if use_ssl
      body = nil
      http.start do |h|
        response = h.get(path)
        body = response.body
      end
      body
    end

    if RUBY_ENGINE == 'mruby'
      class << self
        alias get _get
      end
    end

    # Class method: Get response object
    # Note: Safe from mruby/c limitation as no instance method with same name exists
    def self.get_response(uri_or_host, path = nil, port = nil)
      if uri_or_host.is_a?(String) && uri_or_host.start_with?('http')
        # Parse URI
        uri = URI.parse(uri_or_host)
        host = uri.host
        path = uri.request_uri
        port = uri.port
        use_ssl = uri.scheme == 'https'
      else
        host = uri_or_host
        path ||= '/'
        port ||= 80
        use_ssl = false
      end

      http = new(host, port)
      http.use_ssl = use_ssl if use_ssl
      http.start
      begin
        http.get(path)
      ensure
        http.finish
      end
    end

    # Class method: POST form data
    # Note: Safe from mruby/c limitation as no instance method with same name exists
    def self.post_form(url, params)
      uri = URI.parse(url)
      req = Post.new(uri.request_uri)
      req['content-type'] = 'application/x-www-form-urlencoded'
      req.body = URI.encode_www_form(params)

      http = new(uri.host, uri.port)
      http.use_ssl = (uri.scheme == 'https')
      http.start
      begin
        http.request(req)
      ensure
        http.finish
      end
    end

    private

    def new_transport_context
      clock = transport_deadlines? ? @transport_clock : nil
      HTTPTransportContext.new(
        clock,
        @open_timeout,
        @read_timeout,
        @write_timeout,
        @total_timeout,
        @max_response_header_bytes,
        @max_response_body_bytes,
        @max_response_line_bytes
      )
    end

    def connect(context)
      begin
        socket_class = @use_ssl ? SSLSocket : TCPSocket
        unless transport_deadlines?
          if bounded_transport?
            raise HTTPTransportError.new(:unsupported_transport, :before_request)
          end
          if @use_ssl
            ssl_ctx = SSLContext.new
            ssl_ctx.ca_file = @ca_file if @ca_file # steep:ignore
            ssl_ctx.verify_mode = @verify_mode || SSLContext::VERIFY_PEER
            @socket = SSLSocket.open(@address, @port, ssl_ctx)
          else
            @socket = TCPSocket.new(@address, @port)
          end
          @started = true
          return
        end
        if @use_ssl && bounded_transport?
          ca_file = @ca_file
          if @verify_mode == SSLContext::VERIFY_NONE || !ca_file || ca_file.empty?
            raise HTTPTransportError.new(:tls_verification_failed, :before_request)
          end
        end
        deadline = context.open_deadline
        if @use_ssl
          ssl_ctx = SSLContext.new
          ssl_ctx.ca_file = @ca_file if @ca_file # steep:ignore
          ssl_ctx.verify_mode = @verify_mode || SSLContext::VERIFY_PEER
          @socket = SSLSocket.__transport_open(@address, @port, ssl_ctx, deadline)
        else
          @socket = TCPSocket.__transport_open(@address, @port, deadline)
        end
        @started = true
      rescue HTTPTransportError => error
        raise error
      rescue => error
        context.check!(:before_request)
        reason = error.respond_to?(:reason) ? error.reason : nil
        reason = :connect_failed unless reason
        raise HTTPTransportError.new(reason, :before_request)
      end
    end

    def validate_timeout(value)
      unless (value.is_a?(Integer) || value.is_a?(Float)) && value > 0
        raise HTTPRequestError.new(:invalid_transport_configuration, :before_request)
      end
      scaled = value * 1_000_000
      unless scaled > 0 && scaled <= MAX_TRANSPORT_INTEGER && scaled.to_i > 0
        raise HTTPRequestError.new(:invalid_transport_configuration, :before_request)
      end
      value
    end

    def validate_size(value)
      return nil if value.nil?
      unless value.is_a?(Integer) && value >= 0 && value <= MAX_TRANSPORT_INTEGER
        raise HTTPRequestError.new(:invalid_transport_configuration, :before_request)
      end
      value
    end

    def bounded_transport?
      @write_timeout || @total_timeout || @max_request_bytes ||
        @max_response_header_bytes || @max_response_body_bytes || @max_response_line_bytes
    end

    def transport_deadlines?
      socket_class = @use_ssl ? SSLSocket : TCPSocket
      socket_class.const_defined?(:TRANSPORT_DEADLINES)
    end

    def serialize_request(snapshot)
      HTTPGenericRequest.serialize_snapshot(snapshot)
    end

    # Check if using SSL
    def use_ssl?
      @use_ssl
    end
  end


  class HTTPTransportContext
    attr_reader :max_response_header_bytes, :max_response_body_bytes, :max_response_line_bytes

    def initialize(clock, open_timeout, read_timeout, write_timeout, total_timeout,
                   header_limit, body_limit, line_limit)
      @clock = clock
      @read_timeout_us = to_us(read_timeout)
      @write_timeout_us = write_timeout ? to_us(write_timeout) : nil
      if clock
        now = clock.uptime_us
        @open_deadline_us = add_deadline(now, to_us(open_timeout))
        @total_deadline_us = total_timeout ? add_deadline(now, to_us(total_timeout)) : nil
      else
        @open_deadline_us = nil
        @total_deadline_us = nil
      end
      @read_deadline_us = nil
      @write_deadline_us = nil
      @phase = :before_request
      @max_response_header_bytes = header_limit
      @max_response_body_bytes = body_limit
      @max_response_line_bytes = line_limit
    end

    def open_deadline
      return nil unless @clock
      deadline_for(@open_deadline_us, :before_request, :dns_timeout)
    end

    def check!(phase = @phase)
      @phase = phase if phase == :request_started
      return true unless @clock
      now = @clock.uptime_us
      if @total_deadline_us && now >= @total_deadline_us
        raise HTTPTransportError.new(:total_timeout, @phase)
      end
      true
    end

    def write(socket, wire)
      @phase = :request_started
      return socket.write(wire) unless @clock
      if @write_timeout_us
        @write_deadline_us = add_deadline(@clock.uptime_us, @write_timeout_us)
      end
      offset = 0
      size = wire.bytesize
      while offset < size
        deadline = deadline_for(@write_deadline_us, @phase, :write_timeout)
        begin
          count = socket.__transport_write(wire, offset, size - offset, deadline)
        rescue => error
          translate_socket_error(error, :write_failed, :write_timeout)
        end
        unless count.is_a?(Integer) && count > 0 && count <= size - offset
          raise HTTPTransportError.new(:write_failed, @phase)
        end
        offset += count
        if @write_timeout_us
          @write_deadline_us = add_deadline(@clock.uptime_us, @write_timeout_us)
        end
      end
      size
    end

    def read(socket, maxlen)
      return socket.readpartial(maxlen) unless @clock
      if @read_deadline_us.nil?
        @read_deadline_us = add_deadline(@clock.uptime_us, @read_timeout_us)
      end
      deadline = deadline_for(@read_deadline_us, :request_started, :read_timeout)
      begin
        data = socket.__transport_read(maxlen, deadline)
      rescue EOFError
        return nil
      rescue => error
        translate_socket_error(error, :read_failed, :read_timeout)
      end
      if data.is_a?(String) && data.bytesize > 0
        @read_deadline_us = add_deadline(@clock.uptime_us, @read_timeout_us)
      end
      data
    end

    def probe(socket)
      if @read_deadline_us.nil?
        @read_deadline_us = add_deadline(@clock.uptime_us, @read_timeout_us)
      end
      deadline = deadline_for(@read_deadline_us, :request_started, :read_timeout)
      begin
        socket.__transport_eof_probe(deadline)
      rescue => error
        translate_socket_error(error, :read_failed, :read_timeout)
      end
    end

    private

    def deadline_for(stage_deadline, phase, timeout_reason)
      @phase = phase if phase == :request_started
      now = @clock.uptime_us
      if @total_deadline_us && now >= @total_deadline_us
        raise HTTPTransportError.new(:total_timeout, @phase)
      end
      if stage_deadline && now >= stage_deadline
        raise HTTPTransportError.new(timeout_reason, @phase)
      end
      if @total_deadline_us && (!stage_deadline || @total_deadline_us < stage_deadline)
        @total_deadline_us
      else
        stage_deadline
      end
    end

    def translate_socket_error(error, failed_reason, timeout_reason)
      check!(@phase)
      reason = error.respond_to?(:reason) ? error.reason : nil
      reason = timeout_reason if reason == :timeout
      reason = failed_reason unless reason
      raise HTTPTransportError.new(reason, @phase)
    end

    def to_us(seconds)
      (seconds * 1_000_000).to_i
    end

    def add_deadline(now, delta)
      if delta <= 0 || now > HTTP::MAX_TRANSPORT_INTEGER - delta
        raise HTTPRequestError.new(:invalid_transport_configuration, :before_request)
      end
      now + delta
    end
  end
end
