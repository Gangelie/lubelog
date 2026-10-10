"""Preview or explicitly apply TireSeason values to existing records via the API.

Only the TireSeason field of existing IDs is patched. Both tags are left intact.
"""

import argparse
import json
import os
import urllib.parse
import urllib.request


def request(base, path, key, method="GET", payload=None):
    url = urllib.parse.urljoin(base.rstrip("/") + "/", path.lstrip("/"))
    headers = {"x-api-key": key, "culture-invariant": "true"}
    data = None if payload is None else json.dumps(payload).encode()
    if data is not None:
        headers["Content-Type"] = "application/json"
    with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers, method=method), timeout=30) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True, help="LubeLogger URL")
    parser.add_argument("--vehicle-id", required=True, type=int)
    parser.add_argument("--api-key", default=os.environ.get("LUBELOGGER_API_KEY"),
                        help="API key with edit access to this vehicle; defaults to LUBELOGGER_API_KEY")
    parser.add_argument("--apply", action="store_true", help="Write existing records; default is preview only")
    args = parser.parse_args()
    if not args.api_key:
        parser.error("Set LUBELOGGER_API_KEY or pass --api-key")

    path = f"api/vehicle/gasrecords?vehicleId={args.vehicle_id}"
    before = request(args.base_url, path, args.api_key)
    candidates = []
    ambiguous = []
    for record in before:
        tags = set((record.get("tags") or "").split())
        matches = tags & {"Sommerreifen", "Winterreifen"}
        if record.get("tireSeason") or not matches:
            continue
        if len(matches) != 1:
            ambiguous.append(record["id"])
            continue
        candidates.append((record["id"], "Summer" if "Sommerreifen" in matches else "Winter"))

    print(json.dumps({"vehicleId": args.vehicle_id, "updates": candidates, "ambiguousIds": ambiguous}, indent=2))
    if not args.apply:
        print("Preview only. Back up the database, review the IDs, then rerun with --apply.")
        return

    baseline = {record["id"]: record for record in before}
    for record_id, season in candidates:
        result = request(args.base_url, "api/vehicle/gasrecords/tireseason", args.api_key,
                         "PATCH", {"id": record_id, "tireSeason": season})
        if not result.get("success"):
            raise RuntimeError(f"Update failed for record {record_id}: {result}")
    after = {record["id"]: record for record in request(args.base_url, path, args.api_key)}
    if set(after) != set(baseline):
        raise RuntimeError("Record IDs changed; inspect the database backup")
    for record_id, season in candidates:
        original = dict(baseline[record_id])
        updated = dict(after[record_id])
        if original.get("notes") is None and updated.get("notes") == "":
            original["notes"] = ""  # API view models can render missing notes as empty after reordering.
        if updated.pop("tireSeason", None) != season or original.pop("tireSeason", None) is not None or updated != original:
            changes = {key: [original.get(key), updated.get(key)] for key in original.keys() | updated.keys()
                       if original.get(key) != updated.get(key)}
            raise RuntimeError(f"Unexpected change to record {record_id}: {changes}; inspect the database backup")
    print(f"Verified {len(candidates)} existing records; no records were created or deleted.")


if __name__ == "__main__":
    main()
