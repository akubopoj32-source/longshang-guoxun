# AI 模拟巡查图片

以下图片由 Codex 内置 imagegen 生成。图片内容和口述均为模拟数据，适用于开发验收和可重复对照。图片没有果园现场采集信息或真实虫种标注。

| 图片 | 人工核对的可见内容 | 用途 |
|---|---|---|
| `complete.png` | 完整粘板与两只通用蛾状目标 | 可见数量与口述一致或冲突 |
| `partial.png` | 局部粘板与一只可见蛾状目标 | 局部数量不能作为整板计数 |
| `blurred.png` | 严重模糊，无法分辨可数目标 | 验证系统是否保留不确定性 |
| `irrelevant.png` | 室内桌面 | 验证误传照片时是否凭空填报 |

## 生成提示词

### complete.png

Generate a single landscape candid smartphone photograph for a synthetic QA case. At an apple orchard in rural northwestern China, close overhead field-inspection view of a single rectangular pale yellow sticky monitoring insert in an open plain delta trap. All four edges of the insert are clearly visible within the frame, crisp focus. Exactly two easily distinguishable small generic brown moth-like insect silhouettes rest far apart on the insert, one in the upper-left interior and one in the lower-right interior. Make each large enough to visually count at thumbnail size, with empty clean card around them. No other insects, black flecks, people, labels, logos, or numbers. Background softly shows a few apple leaves and dry brown soil around the trap. Natural diffuse daylight, slight handheld perspective, ordinary field phone photograph. Put a small legible neutral watermark with the exact text “AI 模拟样本” in the bottom-right outer margin over background, fully outside the trap and the insert. Single frame, no collage, no border.

### partial.png

Generate a single landscape candid smartphone photograph for a synthetic QA case. In a northwestern Chinese apple orchard, an inspection close-up of one corner of a pale yellow rectangular sticky monitoring insert in a plain field trap. Frame deliberately cuts off most of the insert beyond the right and bottom borders so the full trap cannot be counted. Show exactly one small, sharply visible generic brown moth-like insect silhouette on the visible part of the clean insert, and no other flecks or insects. A little apple foliage and brown soil can be seen at the left edge. Natural ordinary outdoor phone photo, no people, no logos or numbers. Put a small legible neutral watermark with the exact text “AI 模拟样本” in the top-left outer margin over background, entirely outside the insert. Single frame, no collage, no border.

### blurred.png

Generate a single landscape candid smartphone photograph designed for a synthetic QA case about poor photo quality. A plain delta monitoring trap with a pale yellow insert hangs on an apple branch against foliage and earth in a northwestern Chinese orchard. Simulate severe optical defocus plus mild handheld smear across the entire underlying photo. A yellow blur suggests the trap but there must be no individually resolvable insect shapes, spots, text, or numbers within the scene; nobody can reliably count anything on the trap. No people, signage or logos. Overlay a small, legible neutral watermark with the exact text “AI 模拟样本” at the very bottom right as a sharp post-capture overlay. Single frame, no collage, no border.

### irrelevant.png

Generate a single landscape candid smartphone photograph designed as an irrelevant-photo synthetic QA case. A quiet indoor desk with a clean closed dark notebook, a ceramic mug, and the corner of a blank computer keyboard in ordinary indoor light. Frame as an accidentally selected snapshot, normal texture and color. No people, insects, fruit, orchard, trap, signage, writing or logos within the scene. Overlay a small legible neutral watermark with the exact text “AI 模拟样本” in the bottom-right corner. Single frame, no collage, no border.
