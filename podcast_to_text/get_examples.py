#!/usr/bin/env python3

from urllib.request import urlopen
from multiprocessing import Pool
import json
import os

def worker(cur):
    cur["data"] = urlopen(cur["download_url"]).read()
    return cur

def main():
    resp = urlopen("https://api.github.com/repos/seligman/podcast_to_text/contents/examples")
    data = json.load(resp)

    todo, changes = [], 0
    for cur in data:
        if cur["name"].startswith("Example-Results") and cur["name"].endswith(".html"):
            todo.append(cur)
    
    with Pool() as pool:
        for cur in pool.imap(worker, todo):
            print(cur["name"])
            local_data = b''
            if os.path.isfile(cur["name"]):
                with open(cur["name"], "rb") as f:
                    local_data = f.read()

            if local_data == cur['data']:
                print("  Local file is up to date")
            else:
                with open(cur["name"], "wb") as f:
                    f.write(cur['data'])
                print("  Updated")
                changes += 1

    if changes > 0:
        print("There were changes!")
    else:
        print("All files up to date")

if __name__ == "__main__":
    main()
