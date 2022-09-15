#!/usr/bin/env python3

# Use data from 
#   https://github.com/seligman/cloud_sizes
# For a online version of this tool, please see
#   https://seligman.github.io/cloud-ips/

from urllib.request import urlopen
import json
import os
import socket
import struct
import sys

# Helper to download a URL and save a local cached copy
def cache():
    url = "https://raw.githubusercontent.com/seligman/cloud_sizes/master/data/cloud_db.dat"
    fn = "lookup_ip_address.dat"
    if os.path.isfile(fn):
        return open(fn, "rb")
    else:
        # Pull down the raw data
        # Output as a JSON object so consumers can easily ignore it
        print(json.dumps({"info": f"Downloading cached cloud database from {url}"}))
        with urlopen(url) as f_src:
            with open(fn, "wb") as f_dest:
                while True:
                    data = f_src.read(1048576)
                    if len(data) == 0:
                        break
                    f_dest.write(data)
        return open(fn, "rb")

def lookup_ip(db_file, ip):
    # Lookup an IP

    # First off, see if it's IPv6
    ipv6 = ":" in ip
    # Decode the IP to a byte string, add a bit to the front to pick the right page
    ip = (b'\xff' if ipv6 else b'\x00') + socket.inet_pton(socket.AF_INET6 if ipv6 else socket.AF_INET, ip)

    class FileHelper:
        def __init__(self):
            pass
        def __enter__(self, *args, **kargs):
            if isinstance(db_file, str):
                self.f = open(db_file, "rb")
                return self.f
            else:
                return db_file
        def __exit__(self, *args, **kargs):
            if isinstance(db_file, str):
                self.f.close()

    # with open(db_file, "rb") as f:
    with FileHelper() as f:
        f.seek(21)
        # Get the size of a field, and the location of the info dictionary
        _, field_size, info_loc = struct.unpack("!HHQ", f.read(12))

        # For each bit in the IP, starting at byte #7, lookup which page to use
        bit = 6
        offset = 128 * 2
        # While at an even number, lookup the page
        while (offset % 2) == 0:
            bit += 1
            # Seek to the right offset, and move to the page for the give bit
            f.seek((offset // 2) + (((ip[bit // 8] >> (7 - (bit % 8))) & 1) * field_size))
            # Read the next offset
            offset = struct.unpack("!Q", b"\x00" * (8-field_size) + f.read(field_size))[0]

        # All done, so go ahead and read the data size
        f.seek(offset // 2)
        def decode(f, offset):
            # Helper to decode a value
            f.seek(offset)
            val = struct.unpack("!B", f.read(1))[0]
            offset += 1
            if (val & 3) == 1:
                # A dictionary of 63 items or less
                val >>= 2
                ret = {}
                for _ in range(val):
                    k, offset = decode(f, offset)
                    v, offset = decode(f, offset)
                    ret[k] = v
                return ret, offset
            elif (val & 3) == 2:
                # A list of 63 items or less
                val >>= 2
                ret = []
                for _ in range(val):
                    v, offset = decode(f, offset)
                    ret.append(v)
                return ret, offset
            elif (val & 3) == 3:
                # A string
                val >>= 2
                if val == 63:
                    # If it has 63 bytes or more of data, the length is stored in another field
                    val = struct.unpack("!H", f.read(2))[0]
                    offset += 2
                v = f.read(val)
                offset += val
                return v.decode("utf-8"), offset
            else:
                raise Exception()

        info_dict, _ = decode(f, info_loc)

        # Load the information to return
        temp, _ = decode(f, offset // 2)
        ret = []
        # Decode the data into a simple array of dicts to return
        for item in temp:
            item_dict = {"source": info_dict["sources"].get(item[0], item[0])}
            if len(item[1]) > 0:
                item_dict['service'] = item[1]
            if len(item[2]) > 0:
                item_dict['region'] = item[2]
            if len(item[3]) > 0:
                item_dict['prefix'] = item[3]
            ret.append(item_dict)
        return ret

def main():
    if len(sys.argv) == 1:
        print("Need to specify IP to lookup")
        exit(1)
    
    with cache() as f:
        for ip in sys.argv[1:]:
            data = lookup_ip(f, ip)
            if len(data) == 0:
                data.append({"error": "not found"})
            for row in data:
                row["ip"] = ip
                print(json.dumps(row)) 

if __name__ == "__main__":
    main()
