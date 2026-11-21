from __future__ import annotations

from urllib.parse import urlparse

import pytest
from fastapi.testclient import TestClient

from app import db, geo, main, police_api

POLICE_SEARCH_XML = """<?xml version="1.0" encoding="UTF-8"?>
<response>
  <header><resultCode>00</resultCode><resultMag>NORMAL SERVICE</resultMag></header>
  <body>
    <items>
      <item>
        <atcId>F2018113000002322</atcId><fdSn>1</fdSn>
        <fdPrdtNm>남성용 반지갑</fdPrdtNm><fdSbjt>블랙 지갑을 습득</fdSbjt>
        <prdtClNm>지갑 &gt; 남성용 지갑</prdtClNm><clrNm>블랙(검정)</clrNm>
        <fdFilePathImg>https://www.lost112.go.kr/lostnfs/images/uploadImg/r_1.jpg</fdFilePathImg>
        <depPlace>서울강북경찰서</depPlace><fdYmd>2018-11-30</fdYmd>
      </item>
    </items>
    <totalCount>1</totalCount><pageNo>1</pageNo><numOfRows>20</numOfRows>
  </body>
</response>"""

PORTAL_SEARCH_XML = """<?xml version="1.0" encoding="UTF-8"?>
<response>
  <header><resultCode>00</resultCode><resultMsg>OK</resultMsg></header>
  <body>
    <items>
      <item>
        <atcId>V0007722L11170002</atcId><fdSn>2</fdSn>
        <fdPrdtNm>은색지갑</fdPrdtNm><fdSbjt>리본은색지갑</fdSbjt>
        <prdtClNm>지갑&gt;여성지갑</prdtClNm><clrNm>은색</clrNm>
        <fdFilePathImg>/images/sub/upload/r_2.jpg</fdFilePathImg>
        <depPlace>롯데월드매표소</depPlace><fdYmd>20110223</fdYmd>
      </item>
    </items>
    <totalCount>1</totalCount><pageNo>1</pageNo><numOfRows>20</numOfRows>
  </body>
</response>"""

POLICE_DETAIL_XML = """<?xml version="1.0" encoding="UTF-8"?>
<response>
  <header><resultCode>00</resultCode><resultMag>NORMAL SERVICE</resultMag></header>
  <body><items><item>
    <atcId>F2018113000002322</atcId><fdSn>1</fdSn>
    <fdPrdtNm>남성용 반지갑</fdPrdtNm><prdtClNm>지갑 &gt; 남성용 지갑</prdtClNm>
    <fdFilePathImg>https://www.lost112.go.kr/lostnfs/images/uploadImg/r_1.jpg</fdFilePathImg>
    <fdYmd>2018-11-30</fdYmd><fdHor>24</fdHor><fdPlace>노상</fdPlace>
    <depPlace>서울강북경찰서</depPlace><csteSteNm>보관중</csteSteNm>
    <fndKeepOrgnSeNm>관서보관</fndKeepOrgnSeNm><orgId>O0000129</orgId>
    <orgNm>서울강북경찰서</orgNm><tel>02-944-4347</tel>
    <uniq>본인 확인 서류를 지참하세요. &lt;b&gt;특이사항&lt;/b&gt; 없음</uniq>
  </item></items></body>
</response>"""

PORTAL_DETAIL_XML = """<?xml version="1.0" encoding="UTF-8"?>
<response>
  <header><resultCode>00</resultCode><resultMsg>OK</resultMsg></header>
  <body><items><item>
    <atcId>V0007722L11170002</atcId><fdSn>2</fdSn>
    <fdPrdtNm>은색지갑</fdPrdtNm><prdtClNm>지갑&gt;여성지갑</prdtClNm>
    <fdFilePathImg>/images/sub/img04_no_img.gif</fdFilePathImg>
    <fdYmd>20110223</fdYmd><fdHor>1000</fdHor><fdPlace>롯데월드</fdPlace>
    <depPlace>롯데월드매표소</depPlace><csteSteNm>보관중</csteSteNm>
    <fndKeepOrgnSeNm>놀이동산</fndKeepOrgnSeNm><orgId>A0210001</orgId>
    <orgNm>롯데월드</orgNm><tel>02-1234-5678</tel><uniq>없음</uniq>
  </item></items></body>
</response>"""


class FakeResponse:
    def __init__(self, content: bytes = b"", json_data: dict | None = None):
        self.status_code = 200
        self.content = content
        self.text = content.decode("utf-8", "replace")
        self._json = json_data or {}

    def json(self) -> dict:
        return self._json


class FakeClient:
    calls: list[tuple[str, dict]] = []

    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def get(self, url: str, params: dict | None = None, headers: dict | None = None):
        FakeClient.calls.append((url, dict(params or {})))
        if "dapi.kakao.com" in url:
            if "search/keyword" in url:
                return FakeResponse(
                    json_data={
                        "documents": [
                            {
                                "place_name": (params or {}).get("query", "보관기관"),
                                "phone": "02-3701-4301",
                                "address_name": "서울 종로구 종로2가 39-3",
                                "road_address_name": "서울 종로구 종로17길 4",
                                "category_name": "사회,공공기관 > 행정기관 > 경찰서 > 지구대",
                                "place_url": "http://place.map.kakao.com/1190117336",
                                "y": "37.5",
                                "x": "127.0",
                            }
                        ]
                    }
                )
            return FakeResponse(
                json_data={
                    "documents": [
                        {
                            "y": "37.5",
                            "x": "127.0",
                            "road_address": {"address_name": "서울 종로구 세종대로 1"},
                            "address": {},
                        }
                    ]
                }
            )
        if "apis-navi.kakaomobility.com" in url:
            return FakeResponse(
                json_data={
                    "routes": [
                        {
                            "summary": {"distance": 11263, "duration": 2521},
                            "sections": [{"roads": [{"vertexes": [127.0, 37.5, 127.01, 37.51]}]}],
                        }
                    ]
                }
            )
        if "getLosfundInfoAccTpNmCstdyPlace" in url:
            xml = POLICE_SEARCH_XML
        elif "getPtLosfundInfoAccTpNmCstdyPlace" in url:
            xml = PORTAL_SEARCH_XML
        elif "getLosfundDetailInfo" in url:
            xml = POLICE_DETAIL_XML
        elif "getPtLosfundDetailInfo" in url:
            xml = PORTAL_DETAIL_XML
        else:
            xml = "<response><header><resultCode>00</resultCode></header></response>"
        return FakeResponse(content=xml.encode("utf-8"))


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "app.db")
    monkeypatch.setattr(police_api.config, "POLICE_SERVICE_KEY", "test-service-key")
    monkeypatch.setattr(geo.config, "KAKAO_REST_API_KEY", "test-kakao-key")
    monkeypatch.setattr(police_api.httpx, "Client", FakeClient)
    FakeClient.calls.clear()
    with TestClient(main.app) as test_client:
        yield test_client


def test_search_queries_both_sources_and_normalizes(client):
    response = client.post("/api/lostfound/search", json={"keyword": "지갑"})
    assert response.status_code == 200
    body = response.json()
    assert body["query"] == "지갑"
    assert body["sources"] == ["police", "portal"]
    assert len(body["items"]) == 2
    police = next(item for item in body["items"] if item["source"] == "police")
    portal = next(item for item in body["items"] if item["source"] == "portal")
    assert police["foundDate"] == "2018-11-30"
    assert police["display"]["color"] == "블랙(검정)"
    assert portal["foundDate"] == "2011-02-23"
    assert portal["imageUrl"].startswith("https://www.lost112.go.kr/images/")
    paths = [urlparse(url).path for url, _ in FakeClient.calls]
    assert any(path.endswith("/LosfundInfoInqireService/getLosfundInfoAccTpNmCstdyPlace") for path in paths)
    assert any(path.endswith("/LosPtfundInfoInqireService/getPtLosfundInfoAccTpNmCstdyPlace") for path in paths)
    assert all(params["serviceKey"] == "test-service-key" for _, params in FakeClient.calls)


def test_list_queries_both_sources_without_keyword(client):
    response = client.post("/api/lostfound/list", json={"page": 1, "rows": 40})
    assert response.status_code == 200
    body = response.json()
    assert body["query"] == ""
    assert body["sources"] == ["police", "portal"]
    assert len(body["items"]) == 2
    assert all(params["PRDT_NM"] == "" for _, params in FakeClient.calls)


def test_browse_reports_filtered_total_and_scan_metadata(client):
    response = client.post("/api/lostfound/browse", json={
        "keyword": "", "page": 1, "rows": 40, "maxPages": 3,
        "filters": {"color": "블랙(검정)"},
    })
    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 1
    assert body["page"] == 1
    assert body["rows"] == 40
    assert body["scanned"] >= 1
    assert body["filtersApplied"] == {"color": "블랙(검정)"}
    assert body["criteriaApplied"] is False


def test_search_still_requires_keyword(client):
    assert client.post("/api/lostfound/search", json={"keyword": ""}).status_code == 422


def test_search_result_is_cached(client):
    assert client.post("/api/lostfound/search", json={"keyword": "지갑"}).status_code == 200
    first_call_count = len(FakeClient.calls)
    assert client.post("/api/lostfound/search", json={"keyword": "지갑"}).status_code == 200
    assert len(FakeClient.calls) == first_call_count


def test_detail_loads_notes_phone_and_map_link(client):
    response = client.get("/api/lostfound/police/F2018113000002322/1")
    assert response.status_code == 200
    body = response.json()
    assert body["tel"] == "02-944-4347"
    assert "본인 확인 서류" in body["notes"]
    assert "<b>" not in body["notes"]
    assert body["foundDate"] == "2018-11-30"
    assert body["detailLoaded"] is True
    assert body["lat"] == 37.5 and body["lng"] == 127.0
    assert body["mapUrl"].startswith("https://map.kakao.com/link/map/")
    detail_calls = [
        params
        for url, params in FakeClient.calls
        if "getLosfundDetailInfo" in url
    ]
    assert detail_calls[0]["ATC_ID"] == "F2018113000002322"
    assert detail_calls[0]["FD_SN"] == "1"


def test_detail_includes_kakao_place_information(client):
    body = client.get("/api/lostfound/police/F2018113000002322/1").json()
    place = body["place"]
    assert place["name"] == "서울강북경찰서"
    assert place["phone"] == "02-3701-4301"
    assert place["address"] == "서울 종로구 종로2가 39-3"
    assert place["roadAddress"] == "서울 종로구 종로17길 4"
    assert place["openingHours"] is None
    assert place["placeUrl"] == "https://place.map.kakao.com/1190117336"
    assert body["address"] == "서울 종로구 종로17길 4"


def test_map_config_exposes_only_public_javascript_key(client, monkeypatch):
    monkeypatch.setattr(geo.config, "KAKAO_JAVASCRIPT_KEY", "test-js-key")
    monkeypatch.setattr(geo.config, "KAKAO_REST_API_KEY", "secret-rest-key")
    response = client.get("/api/lostfound/map-config")
    assert response.status_code == 200
    assert response.json() == {"javascriptKey": "test-js-key", "available": True}
    assert "secret-rest-key" not in response.text
    assert "test-service-key" not in response.text


def test_geocode_accepts_place_name_and_coordinates(client):
    place_response = client.post("/api/lostfound/geocode", json={"query": "서울역"})
    assert place_response.status_code == 200
    assert place_response.json()["name"] == "서울역"
    assert place_response.json()["lat"] == 37.5

    coord_response = client.post("/api/lostfound/geocode", json={"query": "37.55, 126.99"})
    assert coord_response.status_code == 200
    assert coord_response.json() == {
        "name": "입력한 좌표", "lat": 37.55, "lng": 126.99, "address": "37.55, 126.99",
    }


def test_geocode_reports_unknown_origin(client, monkeypatch):
    monkeypatch.setattr(geo, "place", lambda query: None)
    monkeypatch.setattr(geo, "geocode", lambda query: None)
    response = client.post("/api/lostfound/geocode", json={"query": "없는 장소"})
    assert response.status_code == 404
    assert response.json()["code"] == "origin_not_found"


def test_route_returns_distance_duration_and_link(client):
    response = client.post(
        "/api/lostfound/route",
        json={
            "originLat": 37.5665, "originLng": 126.978,
            "destinationLat": 37.5, "destinationLng": 127.0,
            "destinationName": "종로2가지구대",
            "originName": "서울시청 (기본 출발지)",
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["distance"] == 11263
    assert body["duration"] == 2521
    assert body["path"] == [[37.5, 127.0], [37.51, 127.01]]
    assert body["mapUrl"].startswith("https://map.kakao.com/link/to/")
    assert "from=%EC%84%9C%EC%9A%B8%EC%8B%9C%EC%B2%AD" in body["mapUrl"]
    mobility = [params for url, params in FakeClient.calls if "apis-navi.kakaomobility.com" in url]
    assert mobility[0]["origin"] == "126.9780000,37.5665000"
    assert mobility[0]["destination"] == "127.0000000,37.5000000"


def test_route_rejects_out_of_range_coordinates(client):
    response = client.post(
        "/api/lostfound/route",
        json={
            "originLat": 99, "originLng": 126.978,
            "destinationLat": 37.5, "destinationLng": 127.0,
            "destinationName": "종로2가지구대",
        },
    )
    assert response.status_code == 422


def test_detail_rejects_invalid_id(client):
    response = client.get("/api/lostfound/police/not-an-id/1")
    assert response.status_code == 400
    assert response.json()["code"] == "lostfound_invalid_id"


def test_search_requires_server_key(client, monkeypatch):
    monkeypatch.setattr(police_api.config, "POLICE_SERVICE_KEY", "")
    response = client.post("/api/lostfound/search", json={"keyword": "지갑"})
    assert response.status_code == 503
    assert response.json()["code"] == "lostfound_not_configured"


def test_detail_accepts_real_mixed_alphanumeric_id(client):
    response = client.get("/api/lostfound/portal/V0007722L11170002/1")
    assert response.status_code == 200
    body = response.json()
    assert body["atcId"] == "V0007722L11170002"
    assert body["detailLoaded"] is True


def test_partial_failure_is_not_cached(client, monkeypatch):
    calls: list[str] = []

    def fake_search_all(keyword, page, rows, hints=None):
        calls.append(keyword)
        return {
            "query": keyword,
            "sources": ["portal"],
            "total": 1,
            "items": [],
            "errors": [{"source": "police", "code": "lostfound_upstream", "message": "실패"}],
        }

    monkeypatch.setattr(police_api, "search_all", fake_search_all)
    first = client.post("/api/lostfound/search", json={"keyword": "지갑"})
    second = client.post("/api/lostfound/search", json={"keyword": "지갑"})
    assert first.status_code == second.status_code == 200
    assert second.json()["errors"]
    assert len(calls) == 2


def test_ai_hints_filter_the_full_public_json(client):
    response = client.post("/api/lostfound/search", json={
        "keyword": "검은 가죽 지갑을 찾습니다",
        "hints": {
            "apiKeywords": ["지갑"],
            "include": ["블랙"],
            "any": ["검정", "은색"],
            "exclude": ["은색"],
            "imageFeatures": ["반지갑"],
        },
    })
    assert response.status_code == 200
    body = response.json()
    assert body["apiKeywords"] == ["지갑"]
    # 자연어 원문이 아니라 분리된 핵심 명사만 PRDT_NM으로 전달된다.
    assert all(params["PRDT_NM"] == "지갑" for url, params in FakeClient.calls
               if "getLosfundInfoAccTpNmCstdyPlace" in url or "getPtLosfundInfoAccTpNmCstdyPlace" in url)
    # 블랙(검정) 남성용 반지갑만 조건을 만족한다(포털의 은색지갑은 제외).
    assert [item["source"] for item in body["items"]] == ["police"]
    item = body["items"][0]
    assert item["aiMatch"]["allInclude"] is True
    assert "블랙" in item["aiMatch"]["hits"]
    assert "반지갑" in item["aiMatch"]["hits"]
    assert item["matchScore"] > 0
    assert body["matched"] == 1


def test_ai_hints_not_excludes_and_broad_keywords_are_queried(client):
    response = client.post("/api/lostfound/search", json={
        "keyword": "지갑",
        "hints": {"apiKeywords": ["지갑", "가방"], "exclude": ["은색"]},
    })
    assert response.status_code == 200
    body = response.json()
    assert body["apiKeywords"] == ["지갑", "가방"]
    assert [item["source"] for item in body["items"]] == ["police"]
    keywords = {params["PRDT_NM"] for _, params in FakeClient.calls}
    assert keywords == {"지갑", "가방"}
    assert body["matched"] == 0


def test_ai_hints_do_not_erase_candidates_without_matches(client):
    response = client.post("/api/lostfound/search", json={
        "keyword": "지갑",
        "hints": {"apiKeywords": ["지갑"], "include": ["존재하지 않는 표현"]},
    })
    assert response.status_code == 200
    body = response.json()
    assert len(body["items"]) == 2
    assert body["matched"] == 0
    assert all(item["aiMatch"]["allInclude"] is False for item in body["items"])


def test_ai_hints_are_part_of_the_search_cache_key(client):
    first = client.post("/api/lostfound/search", json={"keyword": "지갑", "hints": {"include": ["블랙"]}})
    first_calls = len(FakeClient.calls)
    second = client.post("/api/lostfound/search", json={"keyword": "지갑", "hints": {"include": ["은색"]}})
    assert first.status_code == second.status_code == 200
    assert len(FakeClient.calls) > first_calls
    assert second.json()["items"][0]["source"] == "portal"
