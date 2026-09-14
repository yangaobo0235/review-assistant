from app.models.review import FieldStatus
from app.rules.compare import compare_values
from app.rules.normalize import normalize_value


def test_detailed_tractor_type_matches_page_business_category() -> None:
    assert normalize_value("old_vehicle.type", "重型半挂牵引车") == "牵引车"
    assert normalize_value("old_vehicle.type", "牵引车") == "牵引车"


def test_detailed_cargo_type_matches_page_business_category() -> None:
    assert normalize_value("old_vehicle.type", "中型仓栅式货车") == "载货汽车"
    assert normalize_value("old_vehicle.type", "载货汽车") == "载货汽车"


def test_engine_model_preserves_leading_i_and_one_difference() -> None:
    assert normalize_value("old_vehicle.engine_model", "1SGe4-460") == "1SGE4460"
    assert normalize_value("old_vehicle.engine_model", "ISGe4-460") == "ISGE4460"

    result = compare_values(
        "old_vehicle.engine_model",
        "1SGe4-460",
        "ISGe4-460",
        [],
    )
    assert result.status is FieldStatus.CONFLICT


def test_fuel_type_treats_electric_labels_as_new_energy() -> None:
    assert normalize_value("new_vehicle.fuel_type", "电") == "新能源"
    assert normalize_value("new_vehicle.fuel_type", "纯电动") == "新能源"
    assert normalize_value("new_vehicle.fuel_type", "新能源") == "新能源"


def test_fuel_type_keeps_hybrid_distinct_from_new_energy() -> None:
    assert normalize_value("new_vehicle.fuel_type", "油电混合") == "混合动力"
    assert normalize_value("new_vehicle.fuel_type", "混合动力") == "混合动力"
    assert normalize_value("new_vehicle.fuel_type", "电") != normalize_value(
        "new_vehicle.fuel_type", "混合动力"
    )
