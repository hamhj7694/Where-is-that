import pytest

from app import config


@pytest.fixture(autouse=True)
def disable_web_reference_by_default():
    """회귀 테스트는 인터넷에 나가지 않는다. 웹 참조가 필요하면 개별 테스트에서 켠다."""
    original = config.WEB_REFERENCE_ENABLED
    config.WEB_REFERENCE_ENABLED = False
    yield
    config.WEB_REFERENCE_ENABLED = original
