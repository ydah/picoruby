module Net
  # --------------------------------------------------------------------------
  # HTTPGenericRequest - HTTP request generation
  # --------------------------------------------------------------------------
  class HTTPGenericRequest
    attr_reader :method, :path
    attr_accessor :body

    def initialize(method, path, initheader = nil)
      @method = method.to_s.upcase
      @path = path
      @header = {}
      @header_keys = [] #: Array[String]
      @body = nil

      # Initialize headers
      if initheader
        ih_keys = initheader.keys
        ihi = 0
        while ihi < ih_keys.size
          self[ih_keys[ihi]] = initheader[ih_keys[ihi]]
          ihi += 1
        end
      end
    end

    # Get header value (case-insensitive)
    def [](key)
      @header[key.downcase]
    end

    # Set header value (case-insensitive)
    def []=(key, value)
      normalized = key.downcase
      keys = @header_keys
      i = 0
      while i < keys.size
        break if keys[i] == normalized
        i += 1
      end
      keys << normalized if i == keys.size
      @header[normalized] = value
    end

    # Delete header (case-insensitive)
    def delete(key)
      normalized = key.downcase
      value = @header.delete(normalized)
      i = 0
      keys = @header_keys
      while i < keys.size
        if keys[i] == normalized
          keys.delete_at(i)
          break
        end
        i += 1
      end
      value
    end

    # Get all header keys
    def each_header
      hkeys = @header_keys
      hi = 0
      while hi < hkeys.size
        yield hkeys[hi], @header[hkeys[hi]]
        hi += 1
      end
    end

    # Set default headers
    def set_default_headers(host, port)
      # Host header
      if port && (port != 80 && port != 443)
        self['host'] = "#{host}:#{port}"
      else
        self['host'] = host
      end

      # User-Agent
      self['user-agent'] ||= 'PicoRuby-Net-HTTP/1.0'

      # Content-Length for requests with body
      if @body
        self['content-length'] = @body&.bytesize.to_s
      end

      # Connection
      self['connection'] ||= 'close'
    end

    # Convert request to HTTP wire format
    def to_s
      snapshot = transport_snapshot(nil)
      self.class.serialize_snapshot(snapshot)
    end

    # Validate and copy the exact bytes that the transport will send. The
    # completed wire String is deliberately built only after the connection.
    def transport_snapshot(limit)
      method = checked_string(@method, :method)
      target = checked_string(@path, :target)
      validate_token(method)
      validate_target(target)

      body = @body.nil? ? '' : checked_string(@body, :body)
      size = checked_add(0, method.bytesize, limit)
      size = checked_add(size, 1, limit)
      size = checked_add(size, target.bytesize, limit)
      size = checked_add(size, 11, limit) # " HTTP/1.1\r\n"
      parts = [] #: Array[String | Integer]
      parts << method.dup
      parts << target.dup

      keys = @header_keys
      i = 0
      keys_size = keys.size
      while i < keys_size
        key = checked_string(keys[i], :header)
        value = checked_string(@header[key], :header)
        validate_token(key)
        validate_header_value(value)
        size = checked_add(size, key.bytesize, limit)
        size = checked_add(size, 2, limit)
        size = checked_add(size, value.bytesize, limit)
        size = checked_add(size, 2, limit)
        parts << self.class.format_header_name(key)
        parts << value.dup
        i += 1
      end
      size = checked_add(size, 2, limit)
      size = checked_add(size, body.bytesize, limit)
      parts << body.dup
      parts << size
      parts
    end

    def self.serialize_snapshot(parts)
      expected = parts[-1]
      body = parts[-2]
      result = "#{parts[0]} #{parts[1]} HTTP/1.1\r\n"
      i = 2
      last_header = parts.size - 2
      while i < last_header
        result << parts[i] << ': ' << parts[i + 1] << "\r\n"
        i += 2
      end
      result << "\r\n" << body
      unless result.bytesize == expected
        raise HTTPRequestError.new(:request_serialization_failed, :before_request)
      end
      result
    end

    def self.format_header_name(key)
      result = ''
      upper = true
      i = 0
      size = key.bytesize
      while i < size
        char = key.byteslice(i, 1) || ''
        result << (upper ? char.upcase : char.downcase)
        upper = char == '-'
        i += 1
      end
      result
    end

    # Check if request expects a response body
    def response_body_permitted?
      @method != 'HEAD'
    end

    # Check if request has a body
    def request_body_permitted?
      %w[POST PUT PATCH].include?(@method)
    end

    private

    def checked_string(value, part)
      unless value.is_a?(String)
        raise HTTPRequestError.new(:invalid_http_request, :before_request, part.to_s)
      end
      value
    end

    def checked_add(total, amount, limit)
      if amount < 0 || (limit && amount > limit - total)
        raise HTTPRequestError.new(:request_too_large, :before_request)
      end
      total + amount
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

    def validate_token(value)
      if value.empty?
        raise HTTPRequestError.new(:invalid_http_request, :before_request)
      end
      i = 0
      size = value.bytesize
      while i < size
        byte = value.getbyte(i) || 0
        unless token_byte?(byte)
          raise HTTPRequestError.new(:invalid_http_request, :before_request)
        end
        i += 1
      end
      value
    end

    def validate_target(target)
      if target.empty? || (target != '*' && target.getbyte(0) != 47)
        raise HTTPRequestError.new(:invalid_http_request, :before_request)
      end
      i = 0
      size = target.bytesize
      while i < size
        byte = target.getbyte(i) || 0
        if byte <= 32 || byte == 127
          raise HTTPRequestError.new(:invalid_http_request, :before_request)
        end
        i += 1
      end
    end

    def validate_header_value(value)
      i = 0
      size = value.bytesize
      while i < size
        byte = value.getbyte(i) || 0
        if byte == 0 || byte == 10 || byte == 13 || (byte < 32 && byte != 9) || byte == 127
          raise HTTPRequestError.new(:invalid_http_request, :before_request)
        end
        i += 1
      end
    end
  end

  # Specific request type classes
  class HTTPRequest < HTTPGenericRequest
    def initialize(path, initheader = nil)
      super('GET', path, initheader)
    end
  end

  class Get < HTTPRequest
    def initialize(path, initheader = nil)
      super(path, initheader)
    end
  end

  class Head < HTTPGenericRequest
    def initialize(path, initheader = nil)
      super('HEAD', path, initheader)
    end
  end

  class Post < HTTPGenericRequest
    def initialize(path, initheader = nil)
      super('POST', path, initheader)
    end
  end

  class Put < HTTPGenericRequest
    def initialize(path, initheader = nil)
      super('PUT', path, initheader)
    end
  end

  class Delete < HTTPGenericRequest
    def initialize(path, initheader = nil)
      super('DELETE', path, initheader)
    end
  end

  class Patch < HTTPGenericRequest
    def initialize(path, initheader = nil)
      super('PATCH', path, initheader)
    end
  end

  class Options < HTTPGenericRequest
    def initialize(path, initheader = nil)
      super('OPTIONS', path, initheader)
    end
  end
end
