"""Run against an isolated published app: python3 tests/fuel_grade_integration.py /path/to/publish."""

import csv
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path


class GradeSelect(HTMLParser):
    def __init__(self, select_id="gasRecordFuelGrade"):
        super().__init__()
        self.select_id = select_id
        self.in_select = False
        self.options = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "select" and attributes.get("id") == self.select_id:
            self.in_select = True
        elif tag == "option" and self.in_select:
            self.options.append((attributes.get("value"), "selected" in attributes))

    def handle_endtag(self, tag):
        if tag == "select":
            self.in_select = False


class FuelGradeIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if len(sys.argv) < 2:
            raise RuntimeError("Pass the dotnet publish output directory")
        cls.temp = tempfile.TemporaryDirectory(prefix="lubelog-fuel-grade-")
        cls.root = Path(cls.temp.name)
        shutil.copytree(Path(sys.argv[1]), cls.root / "app")
        cls.app = cls.root / "app"
        use_defaults = os.environ.get("FUEL_GRADE_TEST_USE_DEFAULTS") == "1"
        if not use_defaults:
            (cls.app / "appsettings.Development.json").write_text(json.dumps({
                "FuelGrades": {"Gasoline": ["Super 95", "E10", "Super Plus 98"],
                               "Diesel": ["Diesel", "Premium Diesel"]}
            }))
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            cls.base = f"http://127.0.0.1:{listener.getsockname()[1]}"
        environment = os.environ.copy()
        environment["ASPNETCORE_ENVIRONMENT"] = "Development"
        if not use_defaults:
            environment["FuelGrades__Gasoline__2"] = "Premium Gasoline"
        else:
            for key in list(environment):
                if key.startswith("FuelGrades__"):
                    del environment[key]
        postgres_connection = environment.get("FUEL_GRADE_TEST_POSTGRES_CONNECTION")
        if postgres_connection:
            environment["POSTGRES_CONNECTION"] = postgres_connection
        else:
            environment.pop("POSTGRES_CONNECTION", None)
        cls.log = (cls.root / "server.log").open("w")
        cls.process = subprocess.Popen(
            [str(Path(os.environ["DOTNET_ROOT"]) / "dotnet"), "CarCareTracker.dll", "--urls", cls.base],
            cwd=cls.app, env=environment, stdout=cls.log, stderr=subprocess.STDOUT)
        for _ in range(120):
            if cls.process.poll() is not None:
                raise RuntimeError("Application exited during startup; see " + str(cls.root / "server.log"))
            try:
                if cls.request("/health")["status"] == "pass":
                    break
            except (urllib.error.URLError, TimeoutError):
                time.sleep(0.25)
        else:
            raise RuntimeError("Application did not become healthy")

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        try:
            cls.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            cls.process.kill()
            cls.process.wait(timeout=10)
        cls.log.close()
        cls.temp.cleanup()

    @classmethod
    def request(cls, path, method="GET", data=None, form=False):
        if form:
            payload = urllib.parse.urlencode(data or {}).encode()
            content_type = "application/x-www-form-urlencoded"
        elif data is not None:
            payload = json.dumps(data).encode()
            content_type = "application/json"
        else:
            payload = None
            content_type = None
        headers = {} if content_type is None else {"Content-Type": content_type}
        request = urllib.request.Request(cls.base + path, data=payload, headers=headers, method=method)
        with urllib.request.urlopen(request, timeout=10) as response:
            body = response.read()
            if "json" in response.headers.get("Content-Type", ""):
                return json.loads(body)
            return body.decode()

    def add_vehicle(self, plate, fuel_type="Gasoline"):
        result = self.request("/api/vehicles/add", "POST", {
            "year": "2026", "make": "Test", "model": "Fuel Grade", "identifier": "LicensePlate",
            "licensePlate": plate, "fuelType": fuel_type})
        self.assertTrue(result["success"], result)
        return result["additionalData"]["vehicleId"]

    def add_fuel(self, vehicle_id, date, grade=None, season=None, tags=None):
        payload = {"date": date, "odometer": "1000", "fuelConsumed": "30", "cost": "50",
                   "isFillToFull": "true", "missedFuelUp": "false"}
        if grade is not None:
            payload["fuelGrade"] = grade
        if season is not None:
            payload["tireSeason"] = season
        if tags is not None:
            payload["tags"] = tags
        result = self.request(f"/api/vehicle/gasrecords/add?vehicleId={vehicle_id}", "POST", payload)
        self.assertTrue(result["success"], result)
        return result["additionalData"]["recordId"]

    def records(self, vehicle_id):
        return self.request(f"/api/vehicle/gasrecords?vehicleId={vehicle_id}")

    def select(self, vehicle_id, record_id=None):
        path = (f"/Vehicle/GetGasRecordForEditById?gasRecordId={record_id}" if record_id else
                f"/Vehicle/GetAddGasRecordPartialView?vehicleId={vehicle_id}")
        html = self.request(path)
        parser = GradeSelect()
        parser.feed(html)
        self.assertIn('id="gasRecordFuelGrade" class="form-select"', html)
        return parser.options

    def season_select(self, vehicle_id, record_id=None):
        path = (f"/Vehicle/GetGasRecordForEditById?gasRecordId={record_id}" if record_id else
                f"/Vehicle/GetAddGasRecordPartialView?vehicleId={vehicle_id}")
        parser = GradeSelect("gasRecordTireSeason")
        parser.feed(self.request(path))
        return parser.options

    def test_grade_across_ui_api_and_csv(self):
        gasoline = self.add_vehicle("FG-GAS")
        diesel = self.add_vehicle("FG-DIESEL", "Diesel")
        old = self.add_fuel(gasoline, "2026-01-01", "Super 95")
        chosen = self.add_fuel(gasoline, "2026-03-01", "E10")
        self.add_fuel(gasoline, "2026-04-01")  # A newer legacy record has no grade.
        self.add_fuel(diesel, "2026-02-01", "Premium Diesel")

        self.assertIn(("E10", True), self.select(gasoline))
        self.assertIn(("Premium Gasoline", False), self.select(gasoline))
        if os.environ.get("FUEL_GRADE_TEST_USE_DEFAULTS") == "1":
            self.assertIn(("Super Plus 98", False), self.select(gasoline))
        else:
            self.assertNotIn(("Super Plus 98", False), self.select(gasoline))  # Docker env override
        self.assertIn(("Premium Diesel", True), self.select(diesel))
        self.assertNotIn(("E10", True), self.select(diesel))
        self.assertIn(("Super 95", True), self.select(gasoline, old))

        # The native form posts the grade through the same MVC route as other fields.
        ui_result = self.request("/Vehicle/SaveGasRecordToVehicleId", "POST", {
            "gasRecord.vehicleId": gasoline, "gasRecord.date": "2026-05-01",
            "gasRecord.mileage": 2000, "gasRecord.gallons": 30, "gasRecord.cost": 50,
            "gasRecord.fuelGrade": "Premium Gasoline"}, form=True)
        self.assertTrue(ui_result["success"], ui_result)
        self.assertIn(("Premium Gasoline", True), self.select(gasoline))
        ui_record = next(x for x in self.records(gasoline) if x["fuelGrade"] == "Premium Gasoline")
        edit_result = self.request("/Vehicle/SaveGasRecordToVehicleId", "POST", {
            "gasRecord.id": ui_record["id"], "gasRecord.vehicleId": gasoline,
            "gasRecord.date": "2026-05-01", "gasRecord.mileage": 2000,
            "gasRecord.gallons": 30, "gasRecord.cost": 50,
            "gasRecord.fuelGrade": "Super 95"}, form=True)
        self.assertTrue(edit_result["success"], edit_result)
        self.assertIn(("Super 95", True), self.select(gasoline, ui_record["id"]))
        legacy_edit = self.request("/Vehicle/SaveGasRecordToVehicleId", "POST", {
            "gasRecord.id": ui_record["id"], "gasRecord.vehicleId": gasoline,
            "gasRecord.date": "2026-05-01", "gasRecord.mileage": 2000,
            "gasRecord.gallons": 30, "gasRecord.cost": 50}, form=True)
        self.assertTrue(legacy_edit["success"], legacy_edit)
        self.assertIn(("Super 95", True), self.select(gasoline, ui_record["id"]))

        record = next(x for x in self.records(gasoline) if x["id"] == str(chosen))
        self.assertEqual("E10", record["fuelGrade"])
        update = {"id": str(chosen), "date": "2026-03-01", "odometer": "1000",
                  "fuelConsumed": "30", "cost": "50", "isFillToFull": "true", "missedFuelUp": "false"}
        self.assertTrue(self.request("/api/vehicle/gasrecords/update", "PUT", update)["success"])
        self.assertEqual("E10", next(x for x in self.records(gasoline) if x["id"] == str(chosen))["fuelGrade"])
        update["fuelGrade"] = ""
        self.assertTrue(self.request("/api/vehicle/gasrecords/update", "PUT", update)["success"])
        self.assertIsNone(next(x for x in self.records(gasoline) if x["id"] == str(chosen))["fuelGrade"])

        filename = self.request(f"/Vehicle/ExportFromVehicleToCsv?vehicleId={gasoline}&mode=2", "POST", {}, form=True)
        with (self.app / "data" / filename.lstrip("/")).open(newline="") as exported:
            rows = list(csv.DictReader(exported))
        self.assertIn("FuelGrade", rows[0])
        self.assertIn("Super 95", {row["FuelGrade"] for row in rows})
        sample_csv = self.request(f"/Vehicle/GenerateCsvSample?vehicleId={gasoline}&mode=2")
        self.assertIn("FuelGrade", next(csv.reader(io.StringIO(sample_csv))))

        imported_vehicle = self.add_vehicle("FG-ROUNDTRIP")
        result = self.request(
            f"/Vehicle/ImportToVehicleIdFromCsv?vehicleId={imported_vehicle}&mode=2&fileName={urllib.parse.quote(filename.lstrip('/'))}",
            "POST", {}, form=True)
        self.assertTrue(result["success"], result)
        self.assertIn("Super 95", {x["fuelGrade"] for x in self.records(imported_vehicle)})

        legacy = self.app / "data" / "temp" / "legacy-fuel-grade.csv"
        legacy.write_text("Date,Odometer,FuelConsumed,Cost,IsFillToFull,MissedFuelUp\n"
                          "2026-06-01,3000,20,40,true,false\n")
        result = self.request(f"/Vehicle/ImportToVehicleIdFromCsv?vehicleId={diesel}&mode=2&fileName=temp/legacy-fuel-grade.csv", "POST", {}, form=True)
        self.assertTrue(result["success"], result)
        self.assertIn(None, [x["fuelGrade"] for x in self.records(diesel)])

        # Historical values outside current configuration remain selectable.
        archived = self.add_fuel(gasoline, "2026-07-01", "Archived 91")
        self.assertIn(("Archived 91", True), self.select(gasoline, archived))
        self.assertIn(("Archived 91", True), self.select(gasoline))
        self.add_fuel(gasoline, "2026-07-01", "E10")
        self.assertIn(("E10", True), self.select(gasoline))  # Same date: newer record ID wins.

        expensive = self.request(f"/api/vehicle/gasrecords/add?vehicleId={gasoline}", "POST", {
            "date": "2026-08-01", "odometer": "3000", "fuelConsumed": "1",
            "cost": "1234567.89", "isFillToFull": "true", "missedFuelUp": "false"})
        self.assertTrue(expensive["success"], expensive)

        if os.environ.get("FUEL_GRADE_SKIP_BROWSER") != "1" and shutil.which("node") and shutil.which("chromium"):
            browser_test = Path(__file__).with_name("fuel_grade_mobile.mjs")
            screenshot = os.environ.get("FUEL_GRADE_SCREENSHOT")
            command = ["node", str(browser_test), self.base, str(gasoline)]
            if screenshot:
                command.append(screenshot)
            result = subprocess.run(command, text=True, capture_output=True, timeout=45)
            self.assertEqual(0, result.returncode, result.stdout + result.stderr)
            print(result.stdout.strip())

    def test_tire_season_across_ui_api_csv_and_table(self):
        first = self.add_vehicle("TS-FIRST")
        second = self.add_vehicle("TS-SECOND")
        summer = self.add_fuel(first, "2026-01-01", "Super 95", "Summer", "Sommerreifen other")
        winter = self.add_fuel(first, "2026-03-01", "E10", "Winter", "Winterreifen")
        self.add_fuel(first, "2026-04-01")  # A newer undefined season does not replace Winter.
        self.add_fuel(second, "2026-02-01", season="AllSeason")
        self.assertIn(("Winter", True), self.season_select(first))
        self.assertIn(("AllSeason", True), self.season_select(second))
        self.assertIn(("Summer", True), self.season_select(first, summer))

        ui_result = self.request("/Vehicle/SaveGasRecordToVehicleId", "POST", {
            "gasRecord.vehicleId": first, "gasRecord.date": "2026-05-01",
            "gasRecord.mileage": 2000, "gasRecord.gallons": 30, "gasRecord.cost": 50,
            "gasRecord.tireSeason": "AllSeason"}, form=True)
        self.assertTrue(ui_result["success"], ui_result)
        self.assertIn(("AllSeason", True), self.season_select(first))
        ui_record = next(x for x in self.records(first) if x["tireSeason"] == "AllSeason")
        edit_result = self.request("/Vehicle/SaveGasRecordToVehicleId", "POST", {
            "gasRecord.id": ui_record["id"], "gasRecord.vehicleId": first,
            "gasRecord.date": "2026-05-01", "gasRecord.mileage": 2000,
            "gasRecord.gallons": 30, "gasRecord.cost": 50,
            "gasRecord.tireSeason": "Summer"}, form=True)
        self.assertTrue(edit_result["success"], edit_result)
        self.assertIn(("Summer", True), self.season_select(first, ui_record["id"]))
        legacy_edit = self.request("/Vehicle/SaveGasRecordToVehicleId", "POST", {
            "gasRecord.id": ui_record["id"], "gasRecord.vehicleId": first,
            "gasRecord.date": "2026-05-01", "gasRecord.mileage": 2000,
            "gasRecord.gallons": 30, "gasRecord.cost": 50}, form=True)
        self.assertTrue(legacy_edit["success"], legacy_edit)
        self.assertIn(("Summer", True), self.season_select(first, ui_record["id"]))
        self.assertIn(("Summer", True), self.season_select(first))
        self.add_fuel(first, "2025-12-31", season="Winter")
        self.assertIn(("Summer", True), self.season_select(first))  # Date wins over insertion order.
        self.add_fuel(first, "2026-05-01", season="AllSeason")
        self.assertIn(("AllSeason", True), self.season_select(first))  # Same date: later ID wins.
        self.assertIn(("Summer", True), self.season_select(first, ui_record["id"]))

        update = {"id": str(winter), "date": "2026-03-01", "odometer": "1000",
                  "fuelConsumed": "30", "cost": "50", "isFillToFull": "true", "missedFuelUp": "false",
                  "tags": "Winterreifen"}
        self.assertTrue(self.request("/api/vehicle/gasrecords/update", "PUT", update)["success"])
        self.assertEqual("Winter", next(x for x in self.records(first) if x["id"] == str(winter))["tireSeason"])
        update["tireSeason"] = None
        self.assertTrue(self.request("/api/vehicle/gasrecords/update", "PUT", update)["success"])
        self.assertIsNone(next(x for x in self.records(first) if x["id"] == str(winter))["tireSeason"])
        self.assertTrue(self.request("/api/vehicle/gasrecords/tireseason", "PATCH",
                                     {"id": str(winter), "tireSeason": "Winter"})["success"])
        restored = next(x for x in self.records(first) if x["id"] == str(winter))
        self.assertEqual("Winter", restored["tireSeason"])
        self.assertEqual("Winterreifen", restored["tags"])
        self.assertTrue(self.request("/api/vehicle/gasrecords/tireseason", "PATCH",
                                     {"id": str(winter), "tireSeason": None})["success"])
        self.assertIsNone(next(x for x in self.records(first) if x["id"] == str(winter))["tireSeason"])
        with self.assertRaises(urllib.error.HTTPError) as invalid:
            self.request("/api/vehicle/gasrecords/tireseason", "PATCH",
                         {"id": str(winter), "tireSeason": "Monsoon"})
        self.assertEqual(400, invalid.exception.code)

        filename = self.request(f"/Vehicle/ExportFromVehicleToCsv?vehicleId={first}&mode=2", "POST", {}, form=True)
        with (self.app / "data" / filename.lstrip("/")).open(newline="") as exported:
            rows = list(csv.DictReader(exported))
        self.assertIn("TireSeason", rows[0])
        self.assertIn("Summer", {row["TireSeason"] for row in rows})
        sample = self.request(f"/Vehicle/GenerateCsvSample?vehicleId={first}&mode=2")
        self.assertIn("TireSeason", next(csv.reader(io.StringIO(sample))))
        imported = self.add_vehicle("TS-IMPORT")
        result = self.request(f"/Vehicle/ImportToVehicleIdFromCsv?vehicleId={imported}&mode=2&fileName={urllib.parse.quote(filename.lstrip('/'))}",
                              "POST", {}, form=True)
        self.assertTrue(result["success"], result)
        self.assertIn("Summer", {x["tireSeason"] for x in self.records(imported)})
        self.assertIn("Super 95", {x["fuelGrade"] for x in self.records(imported)})

        legacy = self.app / "data" / "temp" / "legacy-tire-season.csv"
        legacy.write_text("Date,Odometer,FuelConsumed,Cost,IsFillToFull,MissedFuelUp\n"
                          "2026-06-01,3000,20,40,true,false\n")
        result = self.request(f"/Vehicle/ImportToVehicleIdFromCsv?vehicleId={second}&mode=2&fileName=temp/legacy-tire-season.csv", "POST", {}, form=True)
        self.assertTrue(result["success"], result)
        self.assertIn(None, [x["tireSeason"] for x in self.records(second)])

        table = self.request(f"/Vehicle/GetGasRecordsByVehicleId?vehicleId={first}")
        for name in ("fuelgrade", "tireseason"):
            self.assertIn(f"data-column-toggle='{name}'", table)
            self.assertIn(f'data-column="{name}"', table)
        self.assertIn("Super 95", table)
        self.assertIn("Summer", table)
        saved = self.request("/Vehicle/SaveUserColumnPreferences", "POST", {
            "columnPreference.tab": 2,
            "columnPreference.visibleColumns[0]": "daterefueled",
            "columnPreference.visibleColumns[1]": "fuelgrade",
            "columnPreference.visibleColumns[2]": "tireseason",
            "columnPreference.columnOrder[0]": "daterefueled",
            "columnPreference.columnOrder[1]": "tireseason",
            "columnPreference.columnOrder[2]": "fuelgrade"}, form=True)
        self.assertTrue(saved)
        reloaded = self.request(f"/Vehicle/GetGasRecordsByVehicleId?vehicleId={first}")
        self.assertIn("loadUserColumnPreferences(visibleColumns, columnsOrder)", reloaded)
        self.assertIn("visibleColumns.push(decodeHTMLEntities('fuelgrade'))", reloaded)
        self.assertIn("visibleColumns.push(decodeHTMLEntities('tireseason'))", reloaded)
        self.assertIn("columnsOrder.push(decodeHTMLEntities('tireseason'))", reloaded)

    def test_optional_tag_migration_is_idempotent(self):
        vehicle = self.add_vehicle("TS-MIGRATE")
        summer = self.add_fuel(vehicle, "2026-01-01", "Super 95", tags="Sommerreifen other")
        winter = self.add_fuel(vehicle, "2026-02-01", "E10", tags="Winterreifen")
        ambiguous = self.add_fuel(vehicle, "2026-03-01", tags="Sommerreifen Winterreifen")
        before = {x["id"]: x for x in self.records(vehicle)}
        command = [sys.executable, str(Path(__file__).parent.parent / "scripts" / "migrate_tire_season_tags.py"),
                   "--base-url", self.base, "--vehicle-id", str(vehicle), "--api-key", "test-key"]
        preview = subprocess.run(command, text=True, capture_output=True, check=True)
        self.assertIn(str(summer), preview.stdout)
        self.assertIn(str(ambiguous), preview.stdout)
        self.assertEqual(before, {x["id"]: x for x in self.records(vehicle)})
        applied = subprocess.run(command + ["--apply"], text=True, capture_output=True)
        self.assertEqual(0, applied.returncode, applied.stdout + applied.stderr)
        self.assertIn("Verified 2 existing records", applied.stdout)
        after = {x["id"]: x for x in self.records(vehicle)}
        self.assertEqual(set(before), set(after))
        for record_id, expected in ((summer, "Summer"), (winter, "Winter")):
            original, updated = dict(before[str(record_id)]), dict(after[str(record_id)])
            if original.get("notes") is None and updated.get("notes") == "":
                original["notes"] = ""
            self.assertIsNone(original.pop("tireSeason"))
            self.assertEqual(expected, updated.pop("tireSeason"))
            self.assertEqual(original, updated)
        self.assertIsNone(after[str(ambiguous)]["tireSeason"])
        repeated = subprocess.run(command + ["--apply"], text=True, capture_output=True)
        self.assertEqual(0, repeated.returncode, repeated.stdout + repeated.stderr)
        self.assertIn("Verified 0 existing records", repeated.stdout)

    def test_electric_mobile_form_keeps_charge_controls(self):
        electric = self.add_vehicle("UX-ELECTRIC", "Electric")
        html = self.request(f"/Vehicle/GetAddGasRecordPartialView?vehicleId={electric}")
        self.assertNotIn('id="gasRecordFuelGrade"', html)
        self.assertNotIn('class="gas-mobile-field gas-mobile-fuelgrade"', html)
        self.assertIn('id="gasRecordTireSeason"', html)
        self.assertIn('class="dual-range-container "', html)
        self.assertIn('data-handle="min"', html)
        self.assertIn('data-handle="max"', html)


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0]], verbosity=2)
