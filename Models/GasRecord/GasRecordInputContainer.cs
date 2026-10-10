namespace CarCareTracker.Models
{
    public class GasRecordInputContainer
    {
        public bool UseKwh { get; set; }
        public bool UseHours { get; set; }
        public List<string> FuelGrades { get; set; } = new List<string>();
        public GasRecordInput GasRecord { get; set; } = new GasRecordInput();
    }
}
