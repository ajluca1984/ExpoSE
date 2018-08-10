var S$ = require('S$');
var x = S$.symbol("X", '');

S$.assume(x.length < 10);

if (/^z+$/.test(x)) {
	
	if (x == '') {
		throw 'Unreachable';
	}

	for (var i = 0; i < x.length; i++) {
		if (x[i] != 'z') {
			throw 'Unreachable';
		}
	}

	throw 'Reachable';
}

throw 'Reachable';