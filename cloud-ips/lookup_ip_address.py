#!/usr/bin/env python3

from urllib.request import urlopen
import gzip
import json
import os
import socket
import sys

# Helper to download a URL and save a local cached copy
def cache(name, url):
    fn = f"cache_{name}.json.gz"
    if os.path.isfile(fn):
        with gzip.open(fn, "rt") as f:
            return json.load(f)
    else:
        # Output as a JSON object so consumers can easily ignore it
        print(json.dumps({"info": f"Downloading data for {name} from {url}"}))
        data = urlopen(url).read()
        if url.endswith(".gz"):
            data = gzip.decompress(data)
        data = json.loads(data)
        with gzip.open(fn, "wt") as f:
            json.dump(data, f, separators=(",", ":"))
        return data

# Load all of the data from the different sources
def load_all():
    caches = {}
    clouds = [
        "aws",
        "google",
        "azure",
        "cloudflare", 
        "digitalocean", 
        "facebook", 
        "hetzner", 
        "icloudprov", 
        "linode", 
        "oracle", 
        "vultr", 
        "private",
    ]

    for cloud in clouds:
        if cloud == "private":
            # We have a hardcoded list in this script
            url = None
        elif cloud == "aws":
            url = "https://ip-ranges.amazonaws.com/ip-ranges.json"
        elif cloud == "google":
            url = "https://www.gstatic.com/ipranges/cloud.json"
        elif cloud == "azure":
            # Leverage the work of a worker to get this file
            url = f"https://raw.githubusercontent.com/seligman/cloud_sizes/master/data/raw_{cloud}.json.gz"
        else:
            # These have non-trivial sources of data, just get a summarized view of their data
            url = f"https://raw.githubusercontent.com/seligman/cloud_sizes/master/data/data_{cloud}.json.gz"
        if url is not None:
            caches[cloud] = cache(cloud, url)
    return clouds, caches

# See if an already decoded IP is inside of a CIDR
# Do this by hand instead of pulling in a library to make this script as
# stand-alone as possible
def ip_in_cidr(check_ip, af, cidr):
    if check_ip[0] != af:
        return False

    cidr = cidr.split("/")
    ip = socket.inet_pton(af, cidr[0])
    netmask = int(cidr[1])

    # IP has been decoded, check each byte
    for a, b in zip(check_ip[1], ip):
        if netmask > 8:
            if a != b:
                return False
            netmask -= 8
        else:
            netmask = (255 >> netmask) ^ 255
            return (a & netmask) == (b & netmask)

# Decode an IP into a byte string
def decode_ip(ip):
    if ":" in ip:
        af = socket.AF_INET6
    else:
        af = socket.AF_INET
    ip = socket.inet_pton(af, ip)
    return af, ip

# Simple helper to dump out results, meant to be somewhat consumable by other scripts
def show_result(source, prefix, region=None, service=None):
    ret = {
        "source": source,
        "prefix": prefix,
    }
    if region is not None:
        ret["region"] = region
    if service is not None:
        ret["service"] = service
    return ret

# Helpers to pull out the data from the different formats
def show_aws(prefix):
    return show_result(
        "aws", 
        prefix.get("ip_prefix", prefix.get("ipv6_prefix")), 
        prefix["region"],
        prefix["service"],
    )

def show_google(prefix):
    return show_result(
        "google", 
        prefix.get("ipv4Prefix", prefix.get("ipv6Prefix")), 
        prefix["scope"],
        prefix["service"],
    )

def show_azure(group, prefix):
    return show_result(
        "azure", 
        prefix, 
        group["properties"].get("region", None),
        group["properties"].get("systemService", None),
    )

def show_other(cloud, prefix):
    return show_result(cloud, prefix)

PRIVATE_IPS = [
    ("0.0.0.0/8", "RFC 1700 broadcast addresses"),
    ("10.0.0.0/8", "RFC 1918 Private address space"),
    ("100.64.0.0/10", "IANA Carrier Grade NAT"),
    ("100.64.0.0/10", "RFC 6598 Carrier graded NAT"),
    ("127.0.0.0/8", "Loopback addresses"),
    ("169.254.0.0/16", "RFC 6890 Link Local address"),
    ("172.16.0.0/12", "RFC 1918 Private address space"),
    ("192.0.0.0/24", "RFC 5736 IANA IPv4 Special Purpose Address Registry"),
    ("192.0.2.0/24", "RFC 5737 TEST-NET for internal use"),
    ("192.168.0.0/16", "RFC 1918 Private address space"),
    ("192.88.99.0/24", "RFC 3068 6to4 anycast relays"),
    ("198.18.0.0/15", "RFC 2544 Testing of inter-network communications"),
    ("198.51.100.0/24", "RFC 5737 TEST-NET-2 for internal use"),
    ("203.0.113.0/24", "RFC 5737 TEST-NET-3 for internal use"),
    ("224.0.0.0/4", "RFC 5771 Multicast Addresses"),
    ("240.0.0.0/4", "RFC 6890 Reserved for future use"),
    ("fd00::/8", "RFC 4193 Unique local address"),
    ("fe80::/10", "RFC 4291 Link Local address"),
    ("::1/128", "Loopback addresses"),
]

# Simply return a series of dictionary objects for a given IP
_clouds, _caches = None, None
def lookup_ip(ip):
    ip = decode_ip(ip)
    global _clouds, _caches
    if _clouds is None:
        _clouds, _caches = load_all()

    for cloud in _clouds:
        if cloud == "private":
            for prefix, desc in PRIVATE_IPS:
                if ip_in_cidr(ip, socket.AF_INET6 if ":" in prefix else socket.AF_INET, prefix):
                    yield show_result("private", prefix, service=desc)
        elif cloud == "aws":
            for prefix in _caches[cloud]["prefixes"]:
                if ip_in_cidr(ip, socket.AF_INET, prefix['ip_prefix']):
                    yield show_aws(prefix)
            for prefix in _caches[cloud]["ipv6_prefixes"]:
                if ip_in_cidr(ip, socket.AF_INET6, prefix['ipv6_prefix']):
                    yield show_aws(prefix)
        elif cloud == "google":
            for prefix in _caches[cloud]["prefixes"]:
                if 'ipv4Prefix' in prefix:
                    if ip_in_cidr(ip, socket.AF_INET, prefix['ipv4Prefix']):
                        yield show_google(prefix)
                else:
                    if ip_in_cidr(ip, socket.AF_INET6, prefix['ipv6Prefix']):
                        yield show_google(prefix)
        elif cloud == "azure":
            for group in _caches[cloud]["values"]:
                for prefix in group['properties']['addressPrefixes']:
                    if ip_in_cidr(ip, socket.AF_INET6 if ":" in prefix else socket.AF_INET, prefix):
                        yield show_azure(group, prefix)
        else:
            for prefix in _caches[cloud]['v4']:
                if ip_in_cidr(ip, socket.AF_INET, prefix):
                    yield show_other(cloud, prefix)
            for prefix in _caches[cloud]['v6']:
                if ip_in_cidr(ip, socket.AF_INET6, prefix):
                    yield show_other(cloud, prefix)

def main():
    if len(sys.argv) == 1:
        print("Need to specify IP to lookup")
        exit(1)
    
    for ip in sys.argv[1:]:
        found = False
        for result in lookup_ip(ip):
            found = True
            # Add the IP to the result data
            result["ip"] = ip
            # Just dump out the results
            print(json.dumps(result)) 
        if not found:
            print(json.dumps({"ip": ip, "warning": "not found"}))

if __name__ == "__main__":
    main()
