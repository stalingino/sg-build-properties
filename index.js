#!/usr/bin/env node

var fs = require('fs');
var path = require('path');
var yaml = require('yamljs');
var lodash = require('lodash');
var program = require('commander');
var colors = require('colors/safe');

program
	.version('0.1.0')
	.option('-e --env [type]', 'Environment properties yml filename without extn [devkinara]')
	.option('-E --env-dir [type]', 'Environment properties directory [sample/environment]', 'default/jenkins/environment/path/here')
	.option('-s --source-dir [type]', 'Source directory in which build.yml is present [/tmp/source]')
	.option('-m --mode [mode]', `Build mode of public/protected/private | 
		Public build which can utilize only public environment variables (urls)
		Protected build which can utilize public & protected environment variables (database credentials & other protected variables)
		Private build which can utilize public, protected & private environment variables (jenkins & server related variables)`,
		/^(public|protected|private)$/i, 'public')
	.parse(process.argv);

console.log('\nBuilding %s for %s as %s', colors.cyan(program.sourceDir), colors.cyan(program.env), colors.cyan(program.mode));

var error = false;
var ERROR = colors.red.bold('ERROR');
var WARNING = colors.yellow.bold('WARNING');
var NOT_FOUND = colors.red('NOT FOUND');

if (program.sourceDir && program.env) {
	var env = null;
	var build = null;
	var envFile = path.join(program.envDir, program.env + '.yml');
	var buildFile = path.join(program.sourceDir, 'build.yml');
	try {
		env = yaml.load(envFile);
	} catch (e) {
		console.log('%s: Environment file %s %s', ERROR, colors.cyan(envFile), NOT_FOUND);
	}
	try {
		build = yaml.load(buildFile);
	} catch (e) {
		console.log('%s: Build file %s %s', ERROR, colors.cyan(buildFile), NOT_FOUND);
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
					var fileContent = fs.readFileSync(propertyFile, 'utf-8');
					var matches = fileContent.match(/{{[\w|\d|\-|\_|\.|\$]+}}/g);
					if (matches && matches.length) {
						matches.forEach(m => {
							var _m = m.match(/{{(.+)}}/)[1];
							var v = lodash.get(env.environment.public, _m);
							var t = 'public';
							if (!v) {
								if (program.mode == 'protected' || program.mode == 'private') {
									v = lodash.get(env.environment.protected, _m);
									t = 'protected';
								}
								if (!v && program.mode == 'private') {
									v = lodash.get(env.environment.private, _m);
									t = 'private';
								}
							}
							if (v) {
								fileContent = fileContent.replace(new RegExp(escapeRegExp(m), 'g'), v);
								console.log('    %s: %s  replaced', colors.cyan.bold(t), colors.cyan(_m));
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
					console.log('%s: Property file "%s" %s', ERROR, colors.cyan(propertyFile), NOT_FOUND);
					error = true;
				}
			});
		} else {
			console.log('%s: There is no property files defined to build', ERROR);
			error = true;
		}
	} else {
		console.log('%s: There is no build environment maintained', ERROR);
		error = true;
	}
}
if (error) {
	console.log('%s. There are error(s) in the build. Pl fix them', colors.red.bold('BUILD FAILED'));
} else {
	console.log(colors.green.bold('BUILD SUCCESS'));
}