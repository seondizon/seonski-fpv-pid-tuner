from __future__ import annotations

from app.tuning.store import craft_id_from_name, get_latest_iteration, load_iterations, save_iteration


def test_craft_id_from_name_sanitizes():
    assert craft_id_from_name("Chimera 7!") == "chimera_7_"
    assert craft_id_from_name(None) == "unnamed"
    assert craft_id_from_name("   ") == "unnamed"


def test_save_and_load_iterations_roundtrip(tmp_path, monkeypatch):
    from app import config

    monkeypatch.setattr(config, "TUNING_STORE_DIR", tmp_path)

    craft_id = "test_craft"
    assert load_iterations(craft_id) == []

    it1 = save_iteration(craft_id, "Baseline", [], {"overall_grade": "FAIR"})
    assert it1.number == 1

    it2 = save_iteration(
        craft_id,
        "Applied",
        [{"parameter": "d_roll", "from": 38, "to": 42}],
        {"overall_grade": "GOOD"},
    )
    assert it2.number == 2

    loaded = load_iterations(craft_id)
    assert len(loaded) == 2
    assert loaded[0].label == "Baseline"
    assert loaded[1].applied_changes == [{"parameter": "d_roll", "from": 38, "to": 42}]

    assert get_latest_iteration(craft_id).number == 2


def test_get_latest_iteration_none_when_empty(tmp_path, monkeypatch):
    from app import config

    monkeypatch.setattr(config, "TUNING_STORE_DIR", tmp_path)
    assert get_latest_iteration("brand_new_craft") is None
