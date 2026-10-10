# Fuel grade selection

Fuel grade is optional on fuel records. Existing records remain valid without one. Gasoline and diesel vehicles have separate dropdown choices; electric vehicles have no fuel grade dropdown. The add form selects the grade from the vehicle's most recent dated fuel record with a grade.

The default gasoline choices are `Super 95`, `E10`, `Super Plus 98`, and `Premium Gasoline`. The default diesel choices are `Diesel` and `Premium Diesel`. To replace them, add arrays to your appsettings configuration:

```json
{
  "FuelGrades": {
    "Gasoline": ["Super 95", "E10", "Super Plus 98", "Premium Gasoline"],
    "Diesel": ["Diesel", "Premium Diesel"]
  }
}
```

Docker Compose can set the same options through .NET configuration environment variables. Define every desired option for a fuel type, starting at index zero:

```yaml
services:
  app:
    image: lubelogger:fuel-grade
    environment:
      FuelGrades__Gasoline__0: "Super 95"
      FuelGrades__Gasoline__1: "E10"
      FuelGrades__Gasoline__2: "Super Plus 98"
      FuelGrades__Gasoline__3: "Premium Gasoline"
      FuelGrades__Diesel__0: "Diesel"
      FuelGrades__Diesel__1: "Premium Diesel"
    ports:
      - "8080:8080"
    volumes:
      - data:/App/data

volumes:
  data:
```

If an appsettings file already defines a list, environment variables override matching indexes but do not remove other indexes. To replace the whole list, configure it in one source or override all existing indexes. Stored grades remain editable when an option is removed from the configuration. The API also accepts a non-listed grade for imported or historical data.

To build an image from this branch, run `docker build -t lubelogger:fuel-grade .` from the repository root, then point your own Compose configuration to that image. Preserve the existing `data` and Data Protection key volumes when adapting an existing deployment.

For focused integration tests, publish to a separate directory and run the test script against an isolated copy:

```bash
dotnet publish CarCareTracker.csproj -c Debug -o /tmp/lubelog-fuel-grade-publish
python3 tests/fuel_grade_integration.py /tmp/lubelog-fuel-grade-publish
```

## Tire season

Fuel records can also store an optional tire season. The stored values are `Summer`, `Winter`, `AllSeason`, or null; UI labels use the translation catalog. The add form selects the value from the vehicle's most recent dated fuel record with a defined tire season, breaking same-date ties by record ID. Editing shows the record's own value. Historical records without the property remain valid. The fuel table's Fuel Grade and Tire Season columns are initially hidden and can be enabled and reordered under **Visible Columns**; the existing user preferences persist both choices.

`TireSeason` is included in CSV exports, sample CSV files, and API reads. CSV imports without the column still work. API updates that omit `tireSeason` preserve it; sending `null` or an empty string clears it. A field-only `PATCH /api/vehicle/gasrecords/tireseason` accepts `{"id":"123","tireSeason":"Summer"}` with edit permission. It is used by the optional migration below and leaves all other fields untouched. Invalid values are rejected; no database migration or change to fuel-economy calculations is needed for LiteDB or PostgreSQL.

To preview a tag migration for one vehicle, first back up the database and create an API key with edit permission for the vehicle. Run:

```bash
LUBELOGGER_API_KEY=YOUR_KEY python3 scripts/migrate_tire_season_tags.py --base-url https://your-lubelogger.example --vehicle-id 123
```

The default is a read-only preview of existing record IDs. It maps `Sommerreifen` to `Summer` and `Winterreifen` to `Winter`, skips records with an existing season, and lists records carrying both tags as ambiguous for manual review. After reviewing the IDs, append `--apply`. The script patches only existing IDs, verifies the record count and returned non-season values, and is safe to rerun: already populated records are skipped. It never removes tags or creates fuel records. Run it separately for each vehicle. No migration runs automatically during startup or deployment.

To build a custom image after checking out `custom/fuel-grade`, run `docker build -t lubelogger:fuel-grade-tire-season .` from the repository root. Update only the image reference in your own Compose file when you choose to deploy; retain the existing data and Data Protection key volumes. No TireSeason environment variable is required. Existing `FuelGrades__Gasoline__*` and `FuelGrades__Diesel__*` settings continue to configure the fuel grade choices.
