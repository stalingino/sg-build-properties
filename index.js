#!/usr/bin/env node

require('exit-code');
var fs = require('fs');
var path = require('path');
var yaml = require('yamljs');
var Cryptr = require('cryptr');
var lodash = require('lodash');
var program = require('commander');
var colors = require('colors/safe');
var safeEval = require('safe-eval');
var cryptr = new Cryptr('myTotalySecretDvara');

program
	.version('0.1.0')
	.option('-E --env-dir [type]', 'Environment properties (absolute/relative) directory', '/opt/environments')
	.option('-e --env [type]', 'Environment properties yml filename without extn (e.g., kinara-dev)')
	.option('-c --compile',`Compile expressions in the environment yml file.
				Expression must start with => and supports env() & encrypt() functions. e.g., env("public.site-code"), encrypt("password").
				e.g., expression: => "http://" + env("public.host-name") + ":8080/sample-server"
				encrypt function outputs "fn::decrypt('<encrypted_password>')" which will be used in the build process`)
	.option('-s --source-dir [type]', 'Source directory in which build.yml is present [/tmp/source]')
	.option('-m --mode [type]', `Optionl | [public|protected|private] Build mode
				- public: access to only public (e.g., urls)
				- protected: access to public & protected (e.g., database credentials & other protected variables)
				- private: access to public, protected & private (e.g., jenkins & build server related variables)`,
				/^(public|protected|private)$/i, 'public')
	.option('-r --read-env [type]', 'Returns single property value. This will not decrypt password')
	.option('-k --secret-key [type]', 'Optional | Encryption/Decryption secret key. Same key should be used for decryption')
	.parse(process.argv);

var error = false;
var ERROR = colors.red.bold('ERROR');
var WARNING = colors.yellow.bold('WARNING');
var NOT_FOUND = colors.red('NOT FOUND');

var compileFunction = null;

var getFunctionMatches = str => str.match(/fn\:\:(.+)\(['"](.+)['"]\)/);

var env = null;
var compileScope = {
	encrypt: val => 'fn::decrypt("' + cryptr.encrypt(val) + '")',
	env: val => env? lodash.get(env.environment, val, false): false
};

var envCompile = function(obj, key, callback) {
	for (var i in obj) {
		key += '.' + i;
		if (lodash.isObject(obj[i]) || lodash.isArray(obj[i])) {
			envCompile(obj[i], key, callback);
		} else {
			if (lodash.startsWith(obj[i], '=>')) {
				obj[i] = safeEval(obj[i].substring(2), compileScope);
			}
		}
	}
}

var readEnv = function(key) {
	var v = lodash.get(env.environment.public, key);
	var t = 'public';
	if (!v) {
		if (program.mode == 'protected' || program.mode == 'private') {
			v = lodash.get(env.environment.protected, key);
			t = 'protected';
		}
		if (!v && program.mode == 'private') {
			v = lodash.get(env.environment.private, key);
			t = 'private';
		}
	}
	if (v && lodash.startsWith(v, '=>')) {
		v = safeEval(v.substring(2), compileScope);
	}
	return {
		value: v,
		mode: t
	};
}

function build() {
	if (program.secretKey) {
		cryptr = new Cryptr(program.secretKey);
	}
	if (program.env) {
		var envFile = path.join(program.envDir, program.env + '.yml');
		try {
			env = yaml.load(envFile);
		} catch (e) {
			console.log('%s: Environment file %s %s', ERROR, colors.cyan(envFile), NOT_FOUND);
			return false;
		}

		if (program.compile) {
			if (program.compile !== true) compileFunction = program.compile;
			console.log('\nCompiling functions in %s', colors.cyan(program.env));
			try {
				envCompile(env, '');
				fs.writeFileSync(envFile, yaml.stringify(env, 16), 'utf-8');
			} catch (e) {
				console.log('%s: Compilation FAILED: %s', ERROR, colors.cyan(e.stack));
				return false;
			}
		} else if (program.readEnv) {
			var ev = readEnv(program.readEnv);
			if (ev && ev.value) {
				console.log(ev.value);
				return true;
			}
			return false;
		} else if (program.sourceDir) {
			console.log('\nBuilding %s for %s as %s', colors.cyan(program.sourceDir), colors.cyan(program.env), colors.cyan(program.mode));
			var build = null;
			var buildFile = path.join(program.sourceDir, 'build.yml');
			try {
				build = yaml.load(buildFile);
			} catch (e) {
				console.log('%s: Build file %s %s', ERROR, colors.cyan(buildFile), NOT_FOUND);
				return false;
			}

			if (env && env.environment && env.environment.public) {
				if (build && build['property-files'] && build['property-files'].length) {

					var escapeRegExp = str => str.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&");

					build['property-files'].forEach(v => {
						var vm = v.match(/{{[\w|\d|\-|\_|\.|\$]+}}/g);
						if (vm && vm.length) {
							vm.forEach(m => {
								var _m = m.match(/{{(.+)}}/)[1];
								var _v = lodash.get(env.environment.public, _m);
								if (_v) {
									v = v.replace(new RegExp(escapeRegExp(m), 'g'), _v);
								}
							});
						}
						console.log('\nUpdating properties on: %s', colors.cyan(v));
						var propertyFile = path.join(program.sourceDir, v);

						try {
							var fileContent = null;
							try {
								fileContent = fs.readFileSync(propertyFile, 'utf-8');
							} catch (e) {
								console.log('%s: Property file "%s" %s', ERROR, colors.cyan(propertyFile), NOT_FOUND);
								return false;
							}
							var matches = fileContent.match(/{{[\w|\d|\-|\_|\.|\$]+}}/g);
							if (matches && matches.length) {
								matches.forEach(m => {
									var _m = m.match(/{{(.+)}}/)[1];
									var ev = readEnv(_m);
									if (ev && ev.value) {
										if (lodash.startsWith(ev.value, 'fn::')) {
											var mt = getFunctionMatches(ev.value);
											if (mt.length == 3) {
												if (mt[1] == "decrypt") {
													ev.value = cryptr.decrypt(mt[2]);
												}
											}
										}
										fileContent = fileContent.replace(new RegExp(escapeRegExp(m), 'g'), ev.value);
										console.log('    %s: %s  replaced', colors.cyan.bold(ev.mode), colors.cyan(_m));
									} else {
										console.log('    %s: %s  NOT maintained', ERROR, colors.cyan(_m));
									}
								});
								fs.writeFileSync(propertyFile, fileContent, 'utf-8');
								console.log('UPDATE %s SUCCESS', colors.yellow(v));
							} else {
								console.log('%s: There are no properties defined in %s', WARNING, propertyFile);
							}
						} catch (e) {
							console.log('%s: Property "%s" updation FAILED: %s', ERROR, colors.cyan(propertyFile), colors.cyan(e.stack));
							return false;
						}
					});
				} else {
					console.log('%s: There is no property files defined to build', ERROR);
					return false;
				}
			} else {
				console.log('%s: There is no build environment maintained', ERROR);
				return false;
			}
		} else {
			console.log('%s: REQUIRED --compile or --source-dir PARAMETER', ERROR);
			return false;
		}
	}
	return true;
}

var buildSuccess = build();
if (!program.readEnv) {
	if (buildSuccess) {
		console.log(colors.green.bold('BUILD SUCCESS'));
	} else {
		console.log('%s. There are error(s) in the build. Pl fix them', colors.red.bold('BUILD FAILED'));
	}
}
process.exitCode = buildSuccess? 0: 1;
