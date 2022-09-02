#!/usr/bin/env python3

from urllib.request import urlopen
from bs4 import BeautifulSoup
import json
import re
import os

def dump(value):
    with open("gather_regions.log", "at", newline="") as f:
        f.write(value + "\n")
    print(value)

def main():
    if os.path.isfile("gather_regions.log"):
        os.unlink("gather_regions.log")

    data = urlopen("https://cloud.google.com/compute/docs/regions-zones").read()
    soup = BeautifulSoup(data, features='html5lib')
    ret = {}
    for table in soup.find_all(name='table'):
        for row in table.find_all(name='tr'):
            cells = row.find_all(name='td')
            if len(cells) >= 6:
                region = cells[0].text.strip()[:-2]
                pretty = cells[1].text.strip()
                ret[region] = pretty
    dump("const google_regions = " + json.dumps(ret, indent=4, sort_keys=True) + ";")
    dump("")

    data = urlopen("https://azure.microsoft.com/en-us/global-infrastructure/geographies/").read()
    soup = BeautifulSoup(data, features='html5lib')
    ret = {}
    for table in soup.find_all(name='tbody'):
        temp = []
        for y, row in enumerate(table.find_all(name='tr')):
            for x, cell in enumerate(row.find_all(name='td')):
                if y == 0:
                    temp.append([])
                temp[x].append(cell.text.strip())
                for href in cell.find_all(name="a", href=True):
                    temp[x][y] = href["href"]
        for col in temp:
            m = re.search("regions=(.*?)%", col[6])
            if m is not None:
                region = m.group(1).replace("-", "")
                pretty = col[0]
                ret[region] = pretty
    dump("const azure_regions = " + json.dumps(ret, indent=4, sort_keys=True) + ";")
    dump("")

    data = urlopen("https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-regions-availability-zones.html").read()
    soup = BeautifulSoup(data, features='html5lib')
    ret = {}
    for table in soup.find_all(name='table'):
        for row in table.find_all(name='tr'):
            cells = row.find_all(name='td')
            if len(cells) >= 2:
                region = cells[0].text.strip()
                pretty = cells[1].text.strip()
                ret[region] = pretty
        break
    dump("const aws_regions = " + json.dumps(ret, indent=4, sort_keys=True) + ";")
    dump("")

if __name__ == "__main__":
    main()
