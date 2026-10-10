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
