MRuby::CrossBuild.new("mrbc-wasm") do |conf|
  node_path = `which node 2>/dev/null`.strip
  if !node_path.empty? && File.executable?(node_path)
    ENV['EM_NODE_JS'] = node_path
  end

  # Generate package.json from template with version from version.h
  conf.generate_package_json_from_template(
    "#{MRUBY_ROOT}/mrbgems/picoruby-wasm/npm/mrbc/package.json.template",
    "#{MRUBY_ROOT}/mrbgems/picoruby-wasm/npm/mrbc/package.json"
  )

  toolchain :clang

  conf.set_build_info

  conf.cc.defines << 'PICORB_PLATFORM_WASM'
  conf.cc.defines << "PICORB_PLATFORM_POSIX"
  conf.cc.include_paths << "#{MRUBY_ROOT}/mrbgems/picoruby-mruby/lib/mruby/include"

  conf.cc.command = 'emcc'
  conf.linker.command = 'emcc'
  conf.archiver.command = 'emar'

  # Emscripten flags for Node.js execution
  conf.linker.flags << '-sWASM=1'
  conf.linker.flags << '-sNODERAWFS=1'
  conf.linker.flags << '-sALLOW_MEMORY_GROWTH=1'
  conf.linker.flags << '-sEXPORTED_RUNTIME_METHODS=["callMain"]'
  conf.linker.flags << '-sEXIT_RUNTIME=1'
  conf.linker.flags << '-sEXECUTABLE=1'

  # Set executable extension to .js (generates both .js and .wasm)
  conf.exts.executable = '.js'

  # Compiler gems
  conf.gem core: "mruby-compiler"
  conf.gem core: "mruby-bin-mrbc"

  # Set output binary name
  conf.instance_variable_set :@mrbcfile, "bin/mrbc.wasm"
  conf.disable_libmruby
end
