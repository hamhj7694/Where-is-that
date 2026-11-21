"""공개 습득물 실사진으로 로컬 시각 검색 품질을 회귀 평가한다.

정답쌍이 없는 공개 데이터 특성상 '자기 사진/설명으로 자기 항목을 찾는'
self-retrieval을 쓴다. 파인튜닝 판단은 이 지표와 실제 사용 후기로 함께 한다.

사용:
    .venv\\Scripts\\python.exe scripts\\eval_visual_search.py

결과는 backend/data/eval/visual_search_eval.json에 저장된다(gitignore).
외부 호출은 공개 API 스캔 1~2회, 사진 다운로드 N회, VLM census 1회다.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from types import SimpleNamespace

BASE_DIR = Path(__file__).resolve().parents[1]
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from app import ai_graph, ai_pipeline, local_vision, police_api  # noqa: E402


def _dataset(keyword: str, rows: int, max_pages: int, limit: int):
    payload = police_api.browse_all(keyword, rows=rows, max_pages=max_pages)
    items = [item for item in payload["items"] if item.get("imageUrl")][:limit]
    photos: dict[str, str] = {}
    texts: dict[str, str] = {}
    for item in items:
        data_url = ai_pipeline._fetch_public_image(item["imageUrl"])
        if not data_url:
            continue
        photos[item["id"]] = data_url
        texts[item["id"]] = " ".join(
            str(item.get(field) or "").strip()
            for field in ("name", "subject", "notes")
        ).strip()
    meta = {
        "keyword": keyword,
        "scanned": payload["pagesScanned"],
        "reportedTotal": payload["total"],
        "errors": payload["errors"],
        "itemsWithPhoto": sum(bool(item.get("imageUrl")) for item in payload["items"]),
        "evaluated": len(photos),
    }
    return meta, photos, texts


def _rank(scores: dict[str, int], target: str) -> int:
    ordered = sorted(scores, key=lambda key: (-scores.get(key, 0), key))
    return ordered.index(target) + 1 if target in ordered else len(ordered) + 1


def _aggregate(targets: list[tuple[str, dict[str, int]]]) -> dict:
    ranks = [_rank(scores, target) for target, scores in targets]
    values = [scores.get(target, 0) for target, scores in targets]
    return {
        "count": len(ranks),
        "recallAt1": round(sum(rank == 1 for rank in ranks) / len(ranks), 3) if ranks else 0,
        "recallAt3": round(sum(rank <= 3 for rank in ranks) / len(ranks), 3) if ranks else 0,
        "mrrAt5": round(sum(1 / rank for rank in ranks if rank <= 5) / len(ranks), 3) if ranks else 0,
        "meanTargetScore": round(sum(values) / len(values), 1) if values else 0,
        "zeroScoreRate": round(sum(value == 0 for value in values) / len(values), 3) if values else 0,
        "saturatedRate": round(sum(value == 100 for value in values) / len(values), 3) if values else 0,
        "ranks": dict(zip([target for target, _ in targets], ranks)),
    }


def _image_vectors(photos: dict[str, str], texts: dict[str, str], hints: dict[str, bool]) -> dict:
    return {
        target: local_vision.embed_image(
            local_vision.crop_target(
                image, local_vision.target_labels(texts[target]), hints.get(image, False)
            )[0]
        )
        for target, image in photos.items()
    }


def _raw_cosine_stats(vectors: dict[str, tuple[float, ...]]) -> dict:
    targets = list(vectors)
    self_values = [local_vision._cosine(vectors[key], vectors[key]) for key in targets]
    off_values = [
        local_vision._cosine(vectors[left], vectors[right])
        for index, left in enumerate(targets) for right in targets[index + 1:]
    ]
    off_sorted = sorted(off_values)
    ranks = {}
    for target in targets:
        ordered = sorted(targets, key=lambda key: -local_vision._cosine(vectors[target], vectors[key]))
        ranks[target] = ordered.index(target) + 1
    return {
        "selfMin": round(min(self_values), 4),
        "offMedian": round(off_sorted[len(off_sorted) // 2], 4),
        "offP90": round(off_sorted[int(len(off_sorted) * 0.9)], 4),
        "offMax": round(max(off_sorted), 4),
        "recallAt1": round(sum(rank == 1 for rank in ranks.values()) / len(ranks), 3),
        "ranks": ranks,
    }


def _raw_text_stats(
    photos: dict[str, str], texts: dict[str, str], hints: dict[str, bool],
    vectors: dict[str, tuple[float, ...]],
) -> dict:
    self_values: list[float] = []
    off_values: list[float] = []
    for target in photos:
        prompts = local_vision.text_prompts((texts[target],), texts[target])
        text_vectors = [local_vision.embed_text(prompt) for prompt in prompts]
        scores = {
            candidate: max(
                local_vision._cosine(image_vector, text_vector)
                for text_vector in text_vectors
            )
            for candidate, image_vector in vectors.items()
        }
        self_values.append(scores[target])
        off_values.extend(value for key, value in scores.items() if key != target)
    off_sorted = sorted(off_values)
    return {
        "selfMin": round(min(self_values), 4),
        "selfMean": round(sum(self_values) / len(self_values), 4),
        "offMedian": round(off_sorted[len(off_sorted) // 2], 4),
        "offP90": round(off_sorted[int(len(off_sorted) * 0.9)], 4),
        "offMax": round(max(off_sorted), 4),
    }


def _run_variant(name: str, photos: dict[str, str], texts: dict[str, str], hints: dict[str, bool]):
    image_targets: list[tuple[str, dict[str, int]]] = []
    text_targets: list[tuple[str, dict[str, int]]] = []
    scoped_targets: list[tuple[str, dict[str, int]]] = []
    crop_count = 0

    for target, image in photos.items():
        query_text = texts[target]
        image_scores = local_vision.score_similarity([image], photos, query_text, hints)
        text_scores = local_vision.score_text_image_similarity([query_text], photos, query_text, hints)
        scoped = local_vision.scope_candidates(photos, texts, query_text)
        scoped_scores = (
            local_vision.score_text_image_similarity([query_text], scoped, query_text, hints)
            if target in scoped else {target: 0}
        )
        image_targets.append((target, image_scores))
        text_targets.append((target, text_scores))
        scoped_targets.append((target, scoped_scores))
        crop_count += int(local_vision.crop_target(image, local_vision.target_labels(query_text), hints.get(image, False))[1])

    return {
        "variant": name,
        "cropped": crop_count,
        "imageQuery": _aggregate(image_targets),
        "textQuery": _aggregate(text_targets),
        "scopedTextQuery": _aggregate(scoped_targets),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keyword", default="지갑")
    parser.add_argument("--rows", type=int, default=100)
    parser.add_argument("--max-pages", type=int, default=2)
    parser.add_argument("--limit", type=int, default=12)
    parser.add_argument("--no-vlm", action="store_true", help="VLM census 호출을 생략한다")
    args = parser.parse_args()

    meta, photos, texts = _dataset(args.keyword, args.rows, args.max_pages, args.limit)
    if len(photos) < 2:
        raise SystemExit("평가에 필요한 사진이 2장 미만입니다.")

    original_crop = local_vision.crop_target
    hints: dict[str, bool] = {}
    if not args.no_vlm:
        census_state = {
            "request": SimpleNamespace(references=[], imageFeatures=[], query=args.keyword, candidates=[]),
            "photo_images": photos,
        }
        hints = ai_graph._visual_census(census_state)["vlm_multi"]

    results: dict[str, dict] = {
        "dataset": meta,
        "vlmHints": len(hints),
        "variants": {},
    }
    try:
        local_vision.crop_target = lambda image, _labels, _vlm=False: (image, False)
        results["variants"]["noCrop"] = _run_variant("noCrop", photos, texts, {})
    finally:
        local_vision.crop_target = original_crop

    results["variants"]["yoloCrop"] = _run_variant("yoloCrop", photos, texts, {})
    if hints:
        results["variants"]["yoloPlusVlm"] = _run_variant("yoloPlusVlm", photos, texts, hints)
    vectors = _image_vectors(photos, texts, hints)
    results["rawCosine"] = _raw_cosine_stats(vectors)
    results["rawTextCosine"] = _raw_text_stats(photos, texts, hints, vectors)

    output = BASE_DIR / "data" / "eval" / "visual_search_eval.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"dataset: {meta}")
    print(f"vlm hints: {len(hints)}")
    for variant in results["variants"].values():
        image = variant["imageQuery"]
        text = variant["textQuery"]
        print(
            f"{variant['variant']:>11}: cropped={variant['cropped']:>2} "
            f"image R@1={image['recallAt1']:.3f} R@3={image['recallAt3']:.3f} "
            f"MRR@5={image['mrrAt5']:.3f} mean={image['meanTargetScore']:.1f} "
            f"| text R@1={text['recallAt1']:.3f} R@3={text['recallAt3']:.3f} "
            f"MRR@5={text['mrrAt5']:.3f} mean={text['meanTargetScore']:.1f}"
        )
    print(f"saved: {output}")


if __name__ == "__main__":
    main()
