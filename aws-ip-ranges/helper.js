/* 
    Built using:
    npm install
    mkdir src
    python3 -c "import shutil;shutil.copy('helper.js','src/index.js')"
    npx webpack --mode=production
    # Creates dist/main.js
*/

var Address4 = require('ip-address').Address4;
var Address6 = require('ip-address').Address6;

crackCidr = function(cidr) {
    if (cidr.includes(":")) {
        temp = new Address6(cidr);
    } else {
        temp = new Address4(cidr);
    }
    return [temp.startAddress().bigInteger(), temp.endAddress().bigInteger(), cidr];
}

checkCidr = function(ip, callback, callbackIn) {
    try {
        var v6;
        if (ip.includes(":")) {
            ip = new Address6(ip).bigInteger();
            v6 = true;
        } else {
            ip = new Address4(ip).bigInteger();
            v6 = false;
        }
        for (var i = 0; ; i++) {
            var cidr = callback(i, v6);
            if (cidr === null) {
                break;
            }
            if (ip.compareTo(cidr[0]) >= 0 && ip.compareTo(cidr[1]) <= 0) {
                callbackIn(i, v6);
            }
        }
        return true;
    } catch (error) {
        return false;
    }
}
