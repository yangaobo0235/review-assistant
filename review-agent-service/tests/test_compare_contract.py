from app.rules.compare import compare_values


def test_compare_values_exposes_character_difference_positions():
    result = compare_values("new_vehicle.vin", "ABC123", "ABC223", [])
    assert result.differences == [3]


def test_compare_values_marks_missing_tail_as_different():
    result = compare_values("scrap_certificate.certificate_no", "AB-12", "AB-123", [])
    assert result.differences
