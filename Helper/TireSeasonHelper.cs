using CarCareTracker.Models;

namespace CarCareTracker.Helper
{
    public static class TireSeasonHelper
    {
        public static bool TryNormalize(string? value, out string? season)
        {
            season = null;
            if (string.IsNullOrWhiteSpace(value)) return true;
            season = value.Trim().ToLowerInvariant() switch
            {
                "summer" => "Summer",
                "winter" => "Winter",
                "allseason" => "AllSeason",
                _ => null
            };
            return season != null;
        }

        public static string? GetLastUsed(IEnumerable<GasRecord> records) => records
            .Where(x => !string.IsNullOrWhiteSpace(x.TireSeason))
            .OrderByDescending(x => x.Date).ThenByDescending(x => x.Id)
            .Select(x => x.TireSeason).FirstOrDefault();
    }
}
