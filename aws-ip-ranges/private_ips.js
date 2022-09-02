const private_ips = [
    {"ip_prefix": "0.0.0.0/8", "region": "", "service": "RFC 1700 broadcast addresses", "source": "Private IP"},
    {"ip_prefix": "10.0.0.0/8", "region": "", "service": "RFC 1918 Private address space", "source": "Private IP"},
    {"ip_prefix": "100.64.0.0/10", "region": "", "service": "IANA Carrier Grade NAT", "source": "Private IP"},
    {"ip_prefix": "100.64.0.0/10", "region": "", "service": "RFC 6598 Carrier graded NAT", "source": "Private IP"},
    {"ip_prefix": "127.0.0.0/8", "region": "", "service": "Loopback addresses", "source": "Private IP"},
    {"ip_prefix": "169.254.0.0/16", "region": "", "service": "RFC 6890 Link Local address", "source": "Private IP"},
    {"ip_prefix": "172.16.0.0/12", "region": "", "service": "RFC 1918 Private address space", "source": "Private IP"},
    {"ip_prefix": "192.0.0.0/24", "region": "", "service": "RFC 5736 IANA IPv4 Special Purpose Address Registry", "source": "Private IP"},
    {"ip_prefix": "192.0.2.0/24", "region": "", "service": "RFC 5737 TEST-NET for internal use", "source": "Private IP"},
    {"ip_prefix": "192.168.0.0/16", "region": "", "service": "RFC 1918 Private address space", "source": "Private IP"},
    {"ip_prefix": "192.88.99.0/24", "region": "", "service": "RFC 3068 6to4 anycast relays", "source": "Private IP"},
    {"ip_prefix": "198.18.0.0/15", "region": "", "service": "RFC 2544 Testing of inter-network communications", "source": "Private IP"},
    {"ip_prefix": "198.51.100.0/24", "region": "", "service": "RFC 5737 TEST-NET-2 for internal use", "source": "Private IP"},
    {"ip_prefix": "203.0.113.0/24", "region": "", "service": "RFC 5737 TEST-NET-3 for internal use", "source": "Private IP"},
    {"ip_prefix": "224.0.0.0/4", "region": "", "service": "RFC 5771 Multicast Addresses", "source": "Private IP"},
    {"ip_prefix": "240.0.0.0/4", "region": "", "service": "RFC 6890 Reserved for future use", "source": "Private IP"},
];
const private_ips6 = [
    {"ipv6_prefix": "fd00::/8", "region": "", "service": "RFC 4193 Unique local address", "source": "Private IP"},
    {"ipv6_prefix": "fe80::/10", "region": "", "service": "RFC 4291 Link Local address", "source": "Private IP"},
    {"ipv6_prefix": "::1/128", "region": "", "service": "Loopback addresses", "source": "Private IP"}, 
];
