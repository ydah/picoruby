module Net
  module HTTPErrorMetadata
    if RUBY_ENGINE == 'mruby/c'
      def reason
        separator = message.index(':')
        separator ? (message.byteslice(0, separator) || '').to_sym : nil
      end

      def phase
        separator = message.index(':')
        return nil unless separator
        value = message.byteslice(separator + 1, message.bytesize - separator - 1) || ''
        value.empty? ? nil : value.to_sym
      end
    else
      attr_reader :reason, :phase

      def initialize(reason = nil, phase = nil, detail = nil)
        @reason = reason
        @phase = phase
        message = reason ? reason.to_s : detail
        super(message || 'HTTP error')
      end
    end
  end

  class HTTPTransportError < IOError
    include HTTPErrorMetadata

    if RUBY_ENGINE == 'mruby/c'
      def self.new(reason = nil, phase = nil, detail = nil)
        super(reason.to_s + ':' + phase.to_s) # steep:ignore
      end
    end
  end

  class HTTPRequestError < ArgumentError
    include HTTPErrorMetadata

    if RUBY_ENGINE == 'mruby/c'
      def self.new(reason = nil, phase = nil, detail = nil)
        super(reason.to_s + ':' + phase.to_s) # steep:ignore
      end
    end
  end

  # Exception for bad HTTP response
  class HTTPBadResponse < StandardError
    include HTTPErrorMetadata

    if RUBY_ENGINE == 'mruby/c'
      def self.new(reason = nil, phase = nil, detail = nil)
        super(reason.to_s + ':' + phase.to_s) # steep:ignore
      end
    end
  end

  # --------------------------------------------------------------------------
  # HTTPResponse - HTTP response parsing and handling
  # --------------------------------------------------------------------------
  class HTTPResponse
    attr_reader :code, :message, :http_version
    attr_accessor :header, :body

    def initialize(code = nil, message = nil, http_version = nil)
      @code = code
      @message = message
      @http_version = http_version
      @header = {}
      @body = nil
    end

    # Parse raw HTTP response
    def self.parse(response_string)
      unless response_string && !response_string.empty?
        raise HTTPBadResponse, "Empty HTTP response"
      end

      header_end = response_string.index("\r\n\r\n")
      unless header_end
        raise HTTPBadResponse.new(:incomplete_http_response, :request_started)
      end
      head = response_string.byteslice(0, header_end + 4) || ''
      reader = HTTPResponseReader.new(nil, nil, nil, nil, nil)
      response = reader.parse_single_head(head)
      body_start = header_end + 4
      if body_start < response_string.bytesize
        response.body = response_string.byteslice(body_start, response_string.bytesize - body_start)
      end
      response
    end

    # Get header value (case-insensitive)
    def [](key)
      @header[key.downcase]
    end

    # Set header value (case-insensitive)
    def []=(key, value)
      @header[key.downcase] = value
    end

    # Get header value (case-insensitive, alias for [])
    def get_fields(key)
      fields = @header_fields
      return [self[key]] unless fields
      normalized = key.downcase
      values = [] #: Array[String]
      i = 0
      while i < fields.size
        values << fields[i][1] if fields[i][0] == normalized
        i += 1
      end
      values
    end

    def __set_header_fields(fields)
      @header_fields = fields
    end

    # Read body (for compatibility)
    def read_body(&block)
      if block
        yield @body || ''
      end
      @body
    end

    # Check if response is successful (2xx)
    def success?
      @code && @code.to_i >= 200 && @code.to_i < 300
    end

    # Check if response is a redirect (3xx)
    def redirect?
      @code && @code.to_i >= 300 && @code.to_i < 400
    end

    # Check if response is a client error (4xx)
    def client_error?
      @code && @code.to_i >= 400 && @code.to_i < 500
    end

    # Check if response is a server error (5xx)
    def server_error?
      @code && @code.to_i >= 500 && @code.to_i < 600
    end

    # Check if response is an error (4xx or 5xx)
    def error?
      client_error? || server_error?
    end

    # Get response code type
    def code_type
      return nil unless @code
      case @code.to_i / 100
      when 1
        HTTPInformation
      when 2
        HTTPSuccess
      when 3
        HTTPRedirection
      when 4
        HTTPClientError
      when 5
        HTTPServerError
      else
        HTTPUnknownResponse
      end
    end

    # Convert to string
    def to_s
      "#{@http_version} #{@code} #{@message}"
    end
  end

  # Response code type classes
  class HTTPInformation < HTTPResponse; end
  class HTTPSuccess < HTTPResponse; end
  class HTTPRedirection < HTTPResponse; end
  class HTTPClientError < HTTPResponse; end
  class HTTPServerError < HTTPResponse; end
  class HTTPUnknownResponse < HTTPResponse; end

  # Specific response classes
  class HTTPOK < HTTPSuccess; end
  class HTTPCreated < HTTPSuccess; end
  class HTTPAccepted < HTTPSuccess; end
  class HTTPNoContent < HTTPSuccess; end
  class HTTPMovedPermanently < HTTPRedirection; end
  class HTTPFound < HTTPRedirection; end
  class HTTPSeeOther < HTTPRedirection; end
  class HTTPNotModified < HTTPRedirection; end
  class HTTPTemporaryRedirect < HTTPRedirection; end
  class HTTPBadRequest < HTTPClientError; end
  class HTTPUnauthorized < HTTPClientError; end
  class HTTPForbidden < HTTPClientError; end
  class HTTPNotFound < HTTPClientError; end
  class HTTPMethodNotAllowed < HTTPClientError; end
  class HTTPInternalServerError < HTTPServerError; end
  class HTTPNotImplemented < HTTPServerError; end
  class HTTPBadGateway < HTTPServerError; end
  class HTTPServiceUnavailable < HTTPServerError; end

  # Incremental HTTP/1 response parser. It never asks the socket for more than
  # the remaining line/body capacity and does not retain the raw response.
  class HTTPResponseReader
    MAX_INTEGER = 0x7fffffffffffffff

    def initialize(socket, request_method, header_limit, body_limit, line_limit, context = nil)
      @socket = socket
      @request_method = request_method
      @header_limit = header_limit
      @body_limit = body_limit
      @line_limit = line_limit
      @context = context
      @buffer = ''
      @header_bytes = 0
    end

    def read
      informational = 0
      while true
        status = read_status_line
        fields = read_headers
        code_number = status[1].to_i
        if 100 <= code_number && code_number < 200
          if code_number == 101 || informational >= 8
            fail_response(:invalid_http_response)
          end
          informational += 1
        else
          return read_final_response(status, fields)
        end
      end
    end

    def parse_single_head(head)
      @buffer = head
      status = read_status_line
      fields = read_headers
      read_response_object(status, fields, nil)
    end

    private

    def read_final_response(status, fields)
      code = status[1].to_i
      transfer_values = field_values(fields, 'transfer-encoding')
      length_values = field_values(fields, 'content-length')
      if !transfer_values.empty? && !length_values.empty?
        fail_response(:invalid_http_response)
      end

      encoding_values = field_values(fields, 'content-encoding')
      i = 0
      while i < encoding_values.size
        value = trim_ows(encoding_values[i]).downcase
        fail_response(:unsupported_content_encoding) unless value == '' || value == 'identity'
        i += 1
      end

      no_body = @request_method == 'HEAD' || code == 204 || code == 304
      if code == 204 && (!transfer_values.empty? || !length_values.empty?)
        fail_response(:invalid_http_response)
      end

      transfer_chunked = false
      unless transfer_values.empty?
        validate_transfer_encoding(transfer_values)
        transfer_chunked = true
      end
      content_length = length_values.empty? ? nil : parse_content_length(length_values)

      body = nil
      unless no_body
        if transfer_chunked
          body = read_chunked_body
        elsif content_length
          if @body_limit && content_length > @body_limit
            fail_response(:response_body_too_large)
          end
          body = read_exact_body(content_length)
        else
          body = read_close_delimited_body
        end
      end
      read_response_object(status, fields, body)
    end

    def read_response_object(status, fields, body)
      response = HTTPResponse.new(status[1], status[2], status[0])
      response.__set_header_fields(fields)
      i = 0
      while i < fields.size
        response.header[fields[i][0]] = fields[i][1]
        i += 1
      end
      response.body = body
      response
    end

    def read_status_line
      line = read_line
      size = line.bytesize
      valid_version = line.start_with?('HTTP/1.0 ') || line.start_with?('HTTP/1.1 ')
      unless valid_version && size >= 13 && line.getbyte(12) == 32
        fail_response(:invalid_http_response)
      end
      i = 9
      while i < 12
        byte = line.getbyte(i) || 0
        fail_response(:invalid_http_response) unless 48 <= byte && byte <= 57
        i += 1
      end
      reason = line.byteslice(13, size - 13) || ''
      validate_field_text(reason)
      [line.byteslice(5, 3) || '', line.byteslice(9, 3) || '', reason]
    end

    def read_headers
      fields = [] #: Array[Array[String]]
      while true
        line = read_line
        break if line.empty?
        fields << parse_header_line(line)
      end
      fields
    end

    def parse_header_line(line)
      colon = line.index(':')
      fail_response(:invalid_http_response) unless colon && 0 < colon
      name = line.byteslice(0, colon) || ''
      validate_field_name(name)
      value_size = line.bytesize - colon - 1
      value = line.byteslice(colon + 1, value_size) || ''
      value = trim_ows(value)
      validate_field_text(value)
      [name.downcase, value]
    end

    def read_line
      while true
        i = 0
        size = @buffer.bytesize
        while i < size
          byte = @buffer.getbyte(i)
          if byte == 10
            fail_response(:invalid_http_response) if i == 0 || @buffer.getbyte(i - 1) != 13
          elsif byte == 13
            if i + 1 < size
              fail_response(:invalid_http_response) unless @buffer.getbyte(i + 1) == 10
              line_size = i + 2
              if @line_limit && line_size > @line_limit
                fail_response(:response_line_too_large)
              end
              add_header_bytes(line_size)
              line = @buffer.byteslice(0, i) || ''
              consume(line_size)
              return line
            end
          end
          i += 1
        end
        if @line_limit && size >= @line_limit
          fail_response(:response_line_too_large)
        end
        maxlen = 100
        if @line_limit
          remaining = @line_limit - size
          maxlen = remaining if remaining < maxlen
        end
        if @header_limit
          remaining = @header_limit - @header_bytes - size
          maxlen = remaining if remaining < maxlen
        end
        fail_response(:response_header_too_large) if maxlen <= 0
        data = socket_read(maxlen)
        fail_response(:incomplete_http_response) unless data
        if data.bytesize > maxlen
          fail_response(:read_failed)
        end
        @buffer << data
      end
    end

    def add_header_bytes(amount)
      if @header_limit && amount > @header_limit - @header_bytes
        fail_response(:response_header_too_large)
      end
      @header_bytes += amount
    end

    def consume(amount)
      remaining = @buffer.bytesize - amount
      @buffer = remaining > 0 ? (@buffer.byteslice(amount, remaining) || '') : ''
    end

    def field_values(fields, name)
      values = [] #: Array[String]
      i = 0
      while i < fields.size
        values << fields[i][1] if fields[i][0] == name
        i += 1
      end
      values
    end

    def parse_content_length(values)
      expected = nil
      i = 0
      while i < values.size
        raw = values[i]
        start = 0
        while start <= raw.bytesize
          comma = raw.index(',', start)
          length = comma ? comma - start : raw.bytesize - start
          part = trim_ows(raw.byteslice(start, length) || '')
          fail_response(:invalid_http_response) if part.empty?
          value = 0
          k = 0
          while k < part.bytesize
            byte = part.getbyte(k) || 0
            fail_response(:invalid_http_response) unless 48 <= byte && byte <= 57
            digit = byte - 48
            fail_response(:invalid_http_response) if value > (MAX_INTEGER - digit) / 10
            value = value * 10 + digit
            k += 1
          end
          fail_response(:invalid_http_response) if expected && value != expected
          expected = value
          break unless comma
          start = comma + 1
        end
        i += 1
      end
      expected || 0
    end

    def validate_transfer_encoding(values)
      if values.size != 1 || trim_ows(values[0]).downcase != 'chunked'
        fail_response(:unsupported_transfer_encoding)
      end
    end

    def read_exact_body(length)
      body = ''
      remaining = length
      while remaining > 0
        amount = remaining < 100 ? remaining : 100
        data = take_data(amount)
        fail_response(:incomplete_http_response) unless data
        body << data
        remaining -= data.bytesize
      end
      body
    end

    def read_chunked_body
      body = ''
      while true
        size = parse_chunk_size(read_line)
        if @body_limit && size > @body_limit - body.bytesize
          fail_response(:response_body_too_large)
        end
        if size == 0
          read_trailers
          return body
        end
        remaining = size
        while remaining > 0
          amount = remaining < 100 ? remaining : 100
          data = take_data(amount)
          fail_response(:incomplete_http_response) unless data
          body << data
          remaining -= data.bytesize
        end
        delimiter = take_exact(2)
        fail_response(:incomplete_http_response) unless delimiter
        fail_response(:invalid_http_response) unless delimiter == "\r\n"
      end
    end

    def parse_chunk_size(line)
      semicolon = line.index(';')
      digits = semicolon ? (line.byteslice(0, semicolon) || '') : line
      fail_response(:invalid_http_response) if digits.empty?
      value = 0
      i = 0
      while i < digits.bytesize
        byte = digits.getbyte(i) || 0
        if 48 <= byte && byte <= 57
          digit = byte - 48
        elsif 65 <= byte && byte <= 70
          digit = byte - 55
        elsif 97 <= byte && byte <= 102
          digit = byte - 87
        else
          fail_response(:invalid_http_response)
        end
        fail_response(:invalid_http_response) if value > (MAX_INTEGER - digit) / 16
        value = value * 16 + digit
        i += 1
      end
      validate_chunk_extensions(line, semicolon + 1) if semicolon
      value
    end

    def validate_chunk_extensions(line, offset)
      i = offset
      size = line.bytesize
      while i < size
        start = i
        i += 1 while i < size && token_byte?(line.getbyte(i) || 0)
        fail_response(:invalid_http_response) if i == start
        if i < size && line.getbyte(i) == 61
          i += 1
          if i < size && line.getbyte(i) == 34
            i += 1
            closed = false
            while i < size
              byte = line.getbyte(i) || 0
              if byte == 34
                closed = true
                i += 1
                break
              elsif byte == 92
                i += 1
                fail_response(:invalid_http_response) if i >= size
                byte = line.getbyte(i) || 0
                fail_response(:invalid_http_response) if byte < 32 || byte == 127
              elsif byte < 32 || byte == 127
                fail_response(:invalid_http_response)
              end
              i += 1
            end
            fail_response(:invalid_http_response) unless closed
          else
            start = i
            i += 1 while i < size && token_byte?(line.getbyte(i) || 0)
            fail_response(:invalid_http_response) if i == start
          end
        end
        break if i == size
        fail_response(:invalid_http_response) unless line.getbyte(i) == 59
        i += 1
      end
    end

    def read_trailers
      while true
        line = read_line
        return if line.empty?
        field = parse_header_line(line)
        if field[0] == 'content-length' || field[0] == 'transfer-encoding'
          fail_response(:invalid_http_response)
        end
      end
    end

    def read_close_delimited_body
      body = ''
      while true
        if !@buffer.empty?
          if @body_limit && @buffer.bytesize > @body_limit - body.bytesize
            fail_response(:response_body_too_large)
          end
          body << @buffer
          @buffer = ''
        end
        if @body_limit && body.bytesize == @body_limit
          probe = socket_probe
          return body if probe == :eof
          fail_response(:response_body_too_large) if probe == :extra_data
          fail_response(:read_failed)
        end
        maxlen = 100
        if @body_limit
          remaining = @body_limit - body.bytesize
          maxlen = remaining if remaining < maxlen
        end
        data = socket_read(maxlen)
        return body unless data
        body << data
      end
    end

    def take_data(maxlen)
      unless @buffer.empty?
        amount = @buffer.bytesize < maxlen ? @buffer.bytesize : maxlen
        data = @buffer.byteslice(0, amount) || ''
        consume(amount)
        return data
      end
      socket_read(maxlen)
    end

    def take_exact(length)
      result = ''
      while result.bytesize < length
        data = take_data(length - result.bytesize)
        return nil unless data
        result << data
      end
      result
    end

    def socket_read(maxlen)
      begin
        data = @context ? @context.read(@socket, maxlen) : @socket.readpartial(maxlen)
        return nil if data.nil?
        fail_response(:read_failed) unless data.is_a?(String) && !data.empty?
        data
      rescue EOFError
        nil
      rescue HTTPTransportError => error
        raise error
      rescue
        fail_response(:read_failed)
      end
    end

    def socket_probe
      unless @socket.respond_to?(:__transport_eof_probe)
        raise HTTPTransportError.new(:unsupported_transport, :request_started)
      end
      begin
        @context ? @context.probe(@socket) : @socket.__transport_eof_probe(nil)
      rescue HTTPTransportError => error
        raise error
      rescue
        fail_response(:read_failed)
      end
    end

    def validate_field_name(name)
      i = 0
      size = name.bytesize
      fail_response(:invalid_http_response) if size == 0
      while i < size
        fail_response(:invalid_http_response) unless token_byte?(name.getbyte(i) || 0)
        i += 1
      end
    end

    def validate_field_text(value)
      i = 0
      size = value.bytesize
      while i < size
        byte = value.getbyte(i) || 0
        if byte == 0 || byte == 10 || byte == 13 || (byte < 32 && byte != 9) || byte == 127
          fail_response(:invalid_http_response)
        end
        i += 1
      end
    end

    def token_byte?(byte)
      return true if 48 <= byte && byte <= 57
      return true if 65 <= byte && byte <= 90
      return true if 97 <= byte && byte <= 122
      byte == 33 || byte == 35 || byte == 36 || byte == 37 ||
        byte == 38 || byte == 39 || byte == 42 || byte == 43 ||
        byte == 45 || byte == 46 || byte == 94 || byte == 95 ||
        byte == 96 || byte == 124 || byte == 126
    end

    def trim_ows(value)
      first = 0
      last = value.bytesize - 1
      while first <= last && (value.getbyte(first) == 32 || value.getbyte(first) == 9)
        first += 1
      end
      while first <= last && (value.getbyte(last) == 32 || value.getbyte(last) == 9)
        last -= 1
      end
      return '' if last < first
      value.byteslice(first, last - first + 1) || ''
    end

    def fail_response(reason)
      raise HTTPBadResponse.new(reason, :request_started)
    end
  end
end
