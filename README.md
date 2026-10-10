# LubeLogger — Gangelie's custom fork

> [!IMPORTANT]
> This is an **unofficial community fork** of [LubeLogger](https://github.com/hargata/lubelog).
> It retains the original project's functionality while adding the features listed below.
> The upstream website, demo, documentation and published Docker images refer to the original project and may **not** include these fork-specific changes.

## What's different from upstream?

| Feature | What this fork adds |
| --- | --- |
| **Fuel grade selection** | An optional fuel-grade dropdown for gasoline and diesel refueling records, with configurable choices and automatic selection based on the latest recorded grade. Fuel-grade data is supported in the API and CSV workflows. |
| **Tire season tracking** | An optional **Summer**, **Winter** or **All Season** value on fuel records. The last recorded season is suggested for new refueling entries; the value is also available through CSV/API and optional fuel-table columns. |
| **Mobile-first fuel entry** | A more convenient phone layout for adding/editing refueling records, including quick tire-season choices, a compact header with save/back actions, and collapsible additional details. Existing desktop behavior is preserved. |
| **Vehicle profile notes** | A multiline **Vehicle Notes (optional)** field in the Add/Edit Vehicle dialog, useful for engine codes, transmission details, equipment and other permanent vehicle information. Line breaks and Unicode characters are retained. |

These fields are optional. Existing vehicle and fuel records without them continue to work; **no database schema migration is required** for LiteDB or PostgreSQL.

For configuration, API behavior and the optional tire-season tag migration, see [Fuel grade and tire season documentation](docs/fuel-grade.md).

## Build and run this fork with Docker

The Docker image from the **upstream** project does not automatically contain this fork's changes. Build this repository's `main` branch locally instead:

```bash
git clone https://github.com/Gangelie/lubelog.git
cd lubelog
docker build -t lubelogger:gangelie .
```

Example `compose.yml` for a **new** installation:

```yaml
services:
  app:
    image: lubelogger:gangelie
    restart: unless-stopped
    ports:
      - "8080:8080"
    volumes:
      - data:/App/data
      - keys:/root/.aspnet/DataProtection-Keys

volumes:
  data:
  keys:
```

Run `docker compose up -d` from the directory containing that `compose.yml` file.

**Existing installation?** Keep your current data and ASP.NET Data Protection key volume mappings when updating. Back up your data before upgrading and change only the image reference to the image you built; don't replace your existing Compose configuration with the example above.

The default fuel-grade choices work without additional configuration. You can customize gasoline/diesel options using `FuelGrades` in application settings or the corresponding `FuelGrades__...` environment variables (see the linked documentation).

## Relationship to the original project

This repository is not an official LubeLogger release or a replacement for upstream support. All original project credits, licensing and general documentation are retained below. If you want **standard LubeLogger**, use [hargata/lubelog](https://github.com/hargata/lubelog).

---

## Original LubeLogger README (upstream information)

![image](https://github.com/hargata/lubelog/assets/155338622/545debcd-d80a-44da-b892-4c652ab0384a)

Self-Hosted, Open-Source, Web-Based Vehicle Maintenance and Fuel Mileage Tracker

Website: https://lubelogger.com

## Why
Because nobody should have to deal with a homemade spreadsheet or a shoebox full of receipts when it comes to vehicle maintenance.

## Showcase
[Promotional Brochure](https://lubelogger.com/brochure.pdf)

[Screenshots](/docs/screenshots.md)

## Demo
Try it out before you download it! The live demo resets every 20 minutes.

[Live Demo](https://demo.lubelogger.com) Login using username "test" and password "1234"

## Download
LubeLogger is available as both a Docker Image and a Windows Standalone Executable.

Read this [Getting Started Guide](https://docs.lubelogger.com/Installation/Getting%20Started) on how to download either of them

### Kubernetes Deployment
[Helm Chart](https://artifacthub.io/packages/helm/anza-labs/lubelogger) provided by [Anza-Labs](https://github.com/anza-labs)

### Need Help?
[Documentation](https://docs.lubelogger.com/)

[Troubleshooting Guide](https://docs.lubelogger.com/Installation/Troubleshooting)

[Search Existing Issues](https://github.com/hargata/lubelog/issues)

## Dependencies
- [Bootstrap](https://github.com/twbs/bootstrap)
- [LiteDB](https://github.com/mbdavid/litedb)
- [Npgsql](https://github.com/npgsql/npgsql)
- [Bootstrap-DatePicker](https://github.com/uxsolutions/bootstrap-datepicker)
- [SweetAlert2](https://github.com/sweetalert2/sweetalert2)
- [CsvHelper](https://github.com/JoshClose/CsvHelper)
- [Chart.js](https://github.com/chartjs/Chart.js)
- [Drawdown](https://github.com/adamvleggett/drawdown)
- [MailKit](https://github.com/jstedfast/MailKit)
- [Masonry](https://github.com/desandro/masonry)
- [QRCode-Generator](https://github.com/kazuhikoarase/qrcode-generator)

## License
MIT

## Support
To support this project, please see [Funding](https://docs.lubelogger.com/Misc/Funding)
