// Built using webpack --mode=production

checkCidr = function(ip, callback, callbackIn) {
    var Address4 = require('ip-address').Address4;
    var Address6 = require('ip-address').Address6;
    try {
        var cidrStart, cidrEnd, v6;
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
            var temp;
            if (v6) {
                temp = new Address6(cidr);
            } else {
                temp = new Address4(cidr);
            }
            cidrStart = temp.startAddress().bigInteger();
            cidrEnd = temp.endAddress().bigInteger();
            if (ip.compareTo(cidrStart) >= 0 && ip.compareTo(cidrEnd) <= 0) {
                callbackIn(i, v6);
            }
        }
        return true;
    } catch (error) {
        return false;
    }
}

// checkCidr('10.20.23.84', function(i, v6) {
//     if (i == 0) {
//         return "10.0.0.0/8";
//     } else {
//         return null;
//     }
// }, function(i, v6) {
//     console.log("match", i);
// })
