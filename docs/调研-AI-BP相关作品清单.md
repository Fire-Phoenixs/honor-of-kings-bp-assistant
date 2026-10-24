# AI 做《王者荣耀》BP 的作品清单（检索于 2026-10-24）

> 结论先说：真正把「AI 自动完成王者荣耀 Ban/Pick」做成公开成果的，主线只有一条——腾讯 AI Lab × 王者荣耀「绝悟」团队的 **JueWuDraft / AI 教练**（论文 + 落地）。开源侧和产品侧目前多是「规则引擎」「BP 模拟器」或「LLM 包装」，尚无成熟的端到端 AI BP 开源实现。

---

## 一、核心研究作品（直接针对王者荣耀）

| # | 作品 | 类型 | 一句话说明 | 链接 |
|---|------|------|-----------|------|
| 1 | **JueWuDraft**：Which Heroes to Pick? Learning to Draft in MOBA Games With Neural Networks and Tree Search | 论文（IEEE Transactions on Games, 2021/2022；腾讯 AI Lab + 上海交大） | 把 BP 建模成「双人零和、完美信息的多轮组合博弈」，用 **PUCT 式 MCTS + 策略/价值网络**选英雄；专为 BO3/BO5「同一英雄只能用一次」设计**长期价值传播**；奖励来自一个 3 层神经网络的**阵容胜率预测器**。在王者荣耀（102 英雄池）上超过 DraftArtist、最高胜率(HWR)、随机三种基线。**局限：该论文只做 Pick，未建模 Ban。** | [arXiv:2012.10171](https://arxiv.org/abs/2012.10171) ・ [IEEE Xplore](https://ieeexplore.ieee.org/document/9476982) |
| 2 | 绝悟「完全体」的 **AI 教练（含 Ban 的完整 BP）** | 工程落地 + 官方技术博客（2020-11/12） | 在 JueWuDraft 基础上把 **Ban 阶段**纳入，形成完整 BP 智能体：自对弈 3000 万局训练阵容胜率预测器，再用其监督估值网络；支持 KPL 的**多轮全局 BP**（BO3/BO5 中英雄不可重复）与长周期判定。官方口径：对贪心策略约 70% 胜率，对按位置随机阵容接近 90%。 | [腾讯云技术博客](https://cloud.tencent.com/developer/article/1755134) ・ [智东西报道](https://m.zhidx.com/p/246122.html) ・ [量子位报道](https://www.qbitai.com/2020/11/20149.html) |
| 3 | Towards Playing Full MOBA Games with Deep Reinforcement Learning（绝悟完全体） | 论文（NeurIPS 2020） | 5v5 全英雄池的 MOBA 智能体，BP/选英雄是其流水线中的一环（主要贡献在微观操作与英雄池泛化）。 | [NeurIPS 2020](https://proceedings.neurips.cc/paper/2020/hash/06d5ae105ea1bea4d800bc96491876e9-Abstract.html) |
| 4 | Hero featured learning algorithm for winning rate prediction of Honor of Kings（HFN） | 论文（IEEE CoG 2022） | 王者荣耀**阵容/实时胜率预测**（分阶段准确率约 84.7%），可作为 BP 的价值函数/评估器。 | [IEEE CoG 2022 PDF](https://ieee-cog.org/2022/assets/papers/paper_98.pdf) |
| 5 | Interpretable Real-Time Win Prediction for Honor of Kings（TSSTN） | 论文（arXiv 2008.06313） | 王者荣耀实时胜率预测 + 可解释中间结果，同样可当 BP 评估器。 | [arXiv](https://arxiv.org/html/2008.06313v3) |

补充中文解读（把 JueWuDraft 讲清楚的二手资料）：
- 机器之心/磐创AI：《王者荣耀AI绝悟如何选英雄？腾讯AI Lab新研究揭秘》 https://cloud.tencent.com/developer/article/1771636
- 《王者荣耀AI绝悟完全体对战开启：论文已被NeurIPS收录》 https://finance.sina.cn/tech/2020-11-28/detail-iiznctke3726126.d.html
- 知乎《〈王者荣耀〉最优阵容选择模型——初探》 https://zhuanlan.zhihu.com/p/375446087

---

## 二、开源项目（GitHub）

| 项目 | 技术路线 | 说明 |
|------|---------|------|
| [YuWangyin/HoK-BP-LLM](https://github.com/YuWangyin/HoK-BP-LLM) | **LLM 微调 + RAG** | 最接近「AI 做 BP」的个人项目：输入当前 BP 阵容 + 3~5 个待选英雄，输出推荐英雄、出装与打法策略；仓库内含 KPL 历年比赛数据、攻略语料、爬虫数据，路线写明「语料库 → 微调 → RAG → 推荐系统」。V1 英雄推荐 / V2 策略 / V3 出装。 |
| [a187898447/kof-bp-assistant](https://github.com/a187898447/kof-bp-assistant) | **CV（pHash 识别）+ 规则建议** | Android 悬浮窗：截图识别对方已选英雄，实时输出阵容意图与对位克制建议（Kotlin）。工程完成度较高，但决策部分是规则库。 |
| [TYJ123z/wzry-helper11](https://github.com/TYJ123z/wzry-helper11) | **规则引擎 + Flask** | 完整模拟征召模式 6 禁 10 选，每步给「版本强势 / 补位 / 克制」推荐与四维阵容评分（S~D）；130 英雄数据。无学习模型。 |
| [tian1miao/-bp-](https://github.com/tian1miao/-bp-) | 未标注 | 「王者荣耀 bp 助手」，仓库内容很少，参考价值有限。 |
| [ShenShiGuiYu/SuperBP](https://github.com/ShenShiGuiYu/SuperBP) | Web 工具（无 AI） | 面向职业/半职业战队的 BP 软件：巅峰赛、**全局 BP（天府赛制）**、自定义推演三种模式，127+ 英雄库。适合当「BP 交互壳」。 |
| [EstoyGenix/HonorOfKingsBPsystem](https://github.com/EstoyGenix/HonorOfKingsBPsystem) | Web 工具（无 AI） | 业余赛直播用 BP 系统模拟器（含推流画面）。 |
| [wangtaoyang/Honor-of-Kings-BP-Expert-Sysrem](https://github.com/wangtaoyang/Honor-of-Kings-BP-Expert-Sysrem) | 专家系统（占位） | 标题是「王者荣耀阵容推荐专家系统」，但仓库目前基本是空文件，不建议参考。 |

---

## 三、产品 / 工具 / 环境（可练手或取数）

| 名称 | 性质 | 说明 |
|------|------|------|
| [HOK Helper · BP 模拟器](https://www.hokhelper.com/zh/tools) | 网页工具 | 完整禁选流程、会话保存与分享，纯人工模拟。 |
| [HOKFIRE Draft Practice](https://www.hokfire.com/draft) | 网页工具 | 蓝/红方先后手与 counter-pick 练习。 |
| [苏苏的荣耀助手](https://pvp.91m.top) | 网页工具/数据站 | 含 **KPL 全局 BP 模拟器**、巅峰千强英雄榜、战力查询等，数据侧可用。 |
| 王者营地（官方 App） | 官方产品 | 「营地 AI」目前是战绩分析 / 智能搜索 / 实时问答，**没有**对外宣称 AI 自动 BP 功能。 [App Store 说明](https://apps.apple.com/cn/app/id1102305688) |
| [Honor of Kings Arena](https://proceedings.neurips.cc/paper_files/paper/2022/hash/4dbb61cb68671edc4ca3712d70083b9f-Abstract-Datasets_and_Benchmarks.html) | 开源环境（NeurIPS 2022 D&B） | 王者荣耀 1v1 泛化强化学习环境，做对局侧实验时可用。 |
| [腾讯开悟 aiarena](https://tencentarena.com/) | 平台/赛事 | 王者荣耀 3v3/5v5 智能体赛题（决策算法），**不是 BP 赛题**，但同生态、有脱敏数据与算力。 |
| [王者荣耀多模态数据集](https://github.com/chg0901/Honor_of_Kings_Multi-modal_Dataset) | 数据集 | 对局视频/解说多模态数据，可自建 BP→胜负语料。 |

---

## 四、方法可迁移的「非王者荣耀」BP 论文（做二次创新时的对照基线）

| 作品 | 场景 | 方法要点 |
|------|------|---------|
| [DraftRec (WWW 2022)](https://arxiv.org/abs/2204.12750) | 英雄联盟 | 个性化（选手英雄池）BP 推荐，图/序列建模。 |
| [Shen et al., A Deep Learning Supported Sequential Recommendation Mechanism for Ban-Pick in MOBA Games (2022)](https://ieeexplore.ieee.org/document/9832346) | MOBA（LoL 英雄） | 把 BP 当序列推荐，Bi-LSTM + NLP 技巧。 |
| [Sequential Item Recommendation in the MOBA Game Dota 2](https://arxiv.org/html/2201.08724v1) | Dota 2 | BERT4Rec 式序列推荐做 pick 预测。 |
| [A Recommender System for Hero Line-Ups in MOBA Games (AIIDE)](https://ojs.aaai.org/index.php/AIIDE/article/view/12938) | MOBA | 阵容级推荐。 |
| [Quantum-Inspired Recommendation and Ban-Pick (TechRxiv 2025)](https://www.techrxiv.org/doi/pdf/10.36227/techrxiv.173833964.49894241) | MOBA | 全局 BP 优化：元学习 + 量子启发多目标。 |
| [Modeling Strategic Drafting in Esports: A Generative AI Approach (HICSS)](https://scholarspace.manoa.hawaii.edu/items/1bf8e995-645d-4b38-9dde-9a1c65980e2d) | MOBA 电竞 | BERT 类生成式模型预测 ban/pick 行为（约 2295 场）。 |
| [Ban-Teemo（LoL，开源）](https://wutims.com/blog/projects/ban-teemo) | 英雄联盟 | 数据驱动 BP 推荐 + LLM 自然语言解释，工程形态可参考。 |

---

## 五、想做的话，最短路径

1. **数据**：KPL 官方赛事数据 + 玩加电竞历史 BP；`HoK-BP-LLM` 仓库里已有整理好的 KPL 历年数据可直接用。
2. **Baseline**：先复现「贪心（当前胜率最高）」和「HWR（历史胜率最高）」，再上序列模型（Bi-LSTM/BERT4Rec）——这是 JueWuDraft 论文里的对照组。
3. **核心价值函数**：训练一个「10 英雄 → 胜率」的预测器（HFN/TSSTN 那类结构即可），BP 搜索（MCTS/束搜索）都以它为奖励。
4. **赛制**：注意 KPL 与 2025 起国际赛（KIS）都采用 **Global Ban&Pick（全局 BP）**——同一英雄一场系列赛只能用一次，必须做跨局状态与长期价值，这正是 JueWuDraft 的卖点。
5. **LLM 路线**：HoK-BP-LLM 的 RAG 方案成本最低，适合做「解释型 BP 助手」，但强度上限低于搜索+胜率模型；两者结合（LLM 出候选+搜索评估）是目前没人公开做过的空档。
