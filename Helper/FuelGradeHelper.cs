using CarCareTracker.Models;

namespace CarCareTracker.Helper
{
    public static class FuelGradeHelper
    {
        private static readonly string[] GasolineDefaults = ["Super 95", "E10", "Super Plus 98", "Premium Gasoline"];
        private static readonly string[] DieselDefaults = ["Diesel", "Premium Diesel"];

        public static string? Normalize(string? grade) => string.IsNullOrWhiteSpace(grade) ? null : grade.Trim();

        public static List<string> GetOptions(IConfiguration configuration, bool isDiesel)
        {
            var section = configuration.GetSection(isDiesel ? "FuelGrades:Diesel" : "FuelGrades:Gasoline");
            var configured = section.Exists() ? section.GetChildren().Select(x => x.Value ?? string.Empty) :
                (isDiesel ? DieselDefaults : GasolineDefaults).AsEnumerable();
            return configured.Select(Normalize).Where(x => x != null).Select(x => x!)
                .Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        }

        public static string? GetLastUsed(IEnumerable<GasRecord> records) => records
            .Where(x => !string.IsNullOrWhiteSpace(x.FuelGrade))
            .OrderByDescending(x => x.Date).ThenByDescending(x => x.Id)
            .Select(x => Normalize(x.FuelGrade)).FirstOrDefault();
    }
}
