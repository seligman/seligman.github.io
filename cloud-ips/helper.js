/* 
    To build this, use ./build_helper.py
*/

var Address4 = require('ip-address').Address4;
var Address6 = require('ip-address').Address6;

ipToBits = function(ip) {
    if (ip.includes(":")) {
        return new Address6(ip).getBitsBase2();
    } else {
        return new Address4(ip).getBitsBase2();
    }
}
