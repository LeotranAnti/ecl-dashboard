import urllib.request
import csv

url = "https://docs.google.com/spreadsheets/d/1Hk4HgyE1x-lw_awem7iN4f4xg-XNPoBvqvp6LDm8G20/export?format=csv&gid=1671069143"
response = urllib.request.urlopen(url)
lines = [line.decode('utf-8') for line in response.readlines()]
reader = csv.reader(lines)
rows = list(reader)

if len(rows) > 0:
    statuses = set()
    for r in rows[1:]:
        if len(r) > 13 and r[13]:
            statuses.add(r[13].strip())
    print("--- UNIQUE STATUSES ---")
    for s in sorted(statuses):
        print(s)
else:
    print("No data fetched.")
