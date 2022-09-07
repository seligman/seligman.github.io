/* 
    To build this, use ./build_helper.js
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

ipToString = function(ip, v6) {
    if (v6) {
        ip = Address6.fromBigInteger(ip).address;
        ip = ip.replace(/\b:?(?:0+:?){2,}/, '::');
        return ip.split(':').map(x => x.replace(/^0+(.)$/, '$1')).join(':');
    } else {
        return Address4.fromBigInteger(ip).address;
    }
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
