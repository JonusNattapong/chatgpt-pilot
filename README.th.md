<p align="center">
  <img src="docs/assets/mcp-tunnel-meme.png" alt="ChatGPT, OpenAI, and MCP Tunnel" width="750">
</p>

# ChatGPT Pilot (คู่มือภาษาไทย)

[![CI/CD](https://github.com/JonusNattapong/chatgpt-pilot/actions/workflows/ci.yml/badge.svg)](https://github.com/JonusNattapong/chatgpt-pilot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![pnpm](https://img.shields.io/badge/pnpm-workspace-orange.svg)](pnpm-workspace.yaml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Model Context Protocol](https://img.shields.io/badge/MCP-2.0-purple.svg)](https://modelcontextprotocol.io/)

ChatGPT Pilot คือ MCP Server ที่เชื่อม ChatGPT, Codex และ MCP Client อื่น ๆ เข้ากับเครื่องของเราโดยตรง พร้อมรวมเครื่องมือจัดการไฟล์และโปรเซส เครื่องมือช่วยคิด คลังทักษะ และหน่วยความจำไว้ในจุดเชื่อมต่อเดียว

ระบบแบ่งความสามารถหลักออกเป็น 4 ส่วน:

- **System & Machine (`apps/server`)**: จัดการไฟล์ภายใต้ขอบเขตที่กำหนด ควบคุมโปรเซสเบื้องหลัง ตรวจสอบ Git ก่อนคอมมิต และรัน Python แบบคงสถานะผ่าน `toolpy`
- **ThinkForge (`packages/thinkforge`)**: ช่วยวิเคราะห์ปัญหา ท้าทายสมมติฐาน จัดกรอบปัญหาใหม่ และออกแบบการทดลองเพื่อทดสอบแนวคิด
- **Skill Hub (`packages/skill-hub`)**: ค้นหา จัดอันดับ และประกอบ workflow จากทักษะ 139 รายการจากโฟลเดอร์ `skills/`
- **Memory (`packages/memory`)**: เก็บข้อมูล การตัดสินใจด้านสถาปัตยกรรม และไทม์ไลน์ในไฟล์ Markdown มาตรฐาน โดยไม่พึ่งฐานข้อมูลไบนารีหรือ Native C++

## สถาปัตยกรรมระบบ

```text
                  ┌─────────────────────────────────────────────────────────┐
                  │                 ChatGPT / Codex Client                  │
                  └────────────────────────────┬────────────────────────────┘
                                               │
                                      Stdio / HTTP Stream
                                               │
                                               ▼
                  ┌─────────────────────────────────────────────────────────┐
                  │        ChatGPT Pilot Gateway (`apps/server`)            │
                  │   - การแยกโปรเซส พร้อม Supervisor Circuit Breaker        │
                  │   - ควบคุมนโยบายความปลอดภัยและบันทึกประวัติ (NDJSON)     │
                  │   - Hybrid Surface (toolpy + capability_registry)       │
                  └───────┬──────────────┬──────────────┬─────────────┬─────┘
                          │              │              │             │
              ┌───────────┴───┐   ┌──────┴──────┐ ┌─────┴─────┐ ┌─────┴──────────┐
              │ System/Machine│   │ ThinkForge  │ │ Skill Hub │ │ Memory Book    │
              │  apps/server  │   │  Cognitive  │ │ Execution │ │ Pure Markdown  │
              └───────────────┘   └─────────────┘ └───────────┘ └────────────────┘
```

## สิ่งที่ต้องมี

- **Node.js**: เวอร์ชัน `22.0.0` ขึ้นไป
- **pnpm**: เวอร์ชัน `9.x` หรือ `10.x`
- **Git**: เวอร์ชัน `2.30.0` ขึ้นไป
- **Python**: เวอร์ชัน `3.10` ขึ้นไปพร้อม `ipykernel` (จำเป็นเฉพาะเมื่อใช้งาน `toolpy`)

## การเริ่มต้นใช้งาน

### 1. Clone โปรเจกต์และติดตั้ง dependencies

```bash
git clone https://github.com/JonusNattapong/chatgpt-pilot.git
cd chatgpt-pilot
pnpm install
```

### 2. Build

```bash
pnpm build
```

### 3. ตรวจสอบการทำงาน

รันคำสั่งต่อไปนี้เพื่อยืนยันว่าโค้ดปัจจุบัน build ได้และผ่าน test ทั้งหมด:

```bash
# รันชุดทดสอบปัจจุบันของทุก workspace package
pnpm test

# ตรวจสอบ Hybrid Capability Surface
pnpm check:hybrid
```

### 4. เชื่อมต่อกับไคลเอนต์ MCP

#### โหมด Stdio (Claude Desktop, Antigravity หรือ CLI บนเครื่อง)

เพิ่ม server ลงในไฟล์ config ของ MCP Client:

```json
{
  "mcpServers": {
    "chatgpt-pilot": {
      "command": "node",
      "args": [
        "<path-to-repo>/apps/server/dist/index.js",
        "--tool-surface", "hybrid",
        "--dangerously-open-machine"
      ]
    }
  }
}
```

#### โหมด Tunnel (ChatGPT Desktop หรือ ChatGPT Web)

หากต้องการใช้งานผ่าน ChatGPT Web หรือ Desktop ให้เปิด tunnel:

- **Windows (PowerShell)**:
  ```powershell
  .\scripts\start-tunnel.ps1
  ```
- **Linux / macOS (Bash)**:
  ```bash
  ./scripts/start-tunnel.sh
  ```

คำสั่งสำหรับตรวจสถานะและควบคุม tunnel:

```bash
# ตรวจสอบสถานะ tunnel
.\scripts\status-tunnel.ps1   # Windows
./scripts/status-tunnel.sh    # Linux/macOS

# หยุด tunnel
.\scripts\stop-tunnel.ps1     # Windows
./scripts/stop-tunnel.sh      # Linux/macOS
```

### Control plane: ตรวจสถานะและกู้ runtime จาก ChatGPT

```text
runtime_info -> ตรวจสถานะ build, HEAD, worker และ fingerprint
capability_diff -> เทียบ worker ที่กำลังทำงานกับ probe จาก build ล่าสุด
restart_if_stale -> restart เฉพาะเมื่อยืนยันได้ว่า worker ใช้สถานะเก่า
self_update -> ff-only origin/main -> build -> verify -> supervised restart -> handshake
```

ก่อนใช้ `self_update` ต้องตั้ง `MCP_ALLOW_SELF_UPDATE=1` ระบบจะปฏิเสธการอัปเดตทันทีหาก working tree ไม่ clean, ไม่ได้อยู่บน `main`, มี commit ที่ยังไม่ได้ push หรือ branch diverge จาก remote

## ส่วนประกอบหลัก

### 1. System & Machine (`apps/server`)

ส่วนนี้เป็นชั้นที่เชื่อมกับเครื่องโดยตรง และเป็นจุดหลักที่บังคับใช้นโยบายความปลอดภัย:

- **เครื่องมือจัดการไฟล์**: อ่านและแก้ไขไฟล์แบบ transactional พร้อมตรวจสอบความถูกต้องด้วย SHA-256 (`read_file`, `write_file`, `edit_file`, `find_files`, `search_code`)
- **การจัดการโปรเซส**: ควบคุมโปรเซสเบื้องหลังผ่าน Supervisor อ่านเอาต์พุตแบบต่อเนื่อง และหยุดโปรเซสได้อย่างเป็นระบบ (`start_process`, `read_process_output`, `process_write`, `process_wait`, `stop_process`)
- **การตรวจสอบ Git ก่อนคอมมิต**: `git_commit_verified` รันคำสั่งตรวจสอบ (`test`, `build`) บน index ชั่วคราว หากตรวจสอบไม่ผ่านหรือพบว่า working tree ถูกแก้ระหว่างตรวจสอบ ระบบจะยกเลิกการคอมมิตทันที
- **Persistent Python (`toolpy`)**: เซสชัน IPython แบบคงสถานะ เก็บตัวแปรข้ามคำสั่งได้ และเรียกความสามารถของ MCP ผ่านฟังก์ชัน Python

#### GPT.md: บริบทสำหรับ ChatGPT Pilot

Pilot โหลดกติกาการทำงานเป็นลำดับชั้นที่ตรวจสอบที่มาได้:

```text
runtime/system security       # กฎบังคับ ห้าม GPT.md ลดระดับความปลอดภัย
        ↓
~/.pilot/GPT.md               # ค่าเริ่มต้นของผู้ใช้ ใช้กับทุก repo
        ↓
<repo>/AGENTS.md              # กติกาวิศวกรรมที่ใช้ร่วมกับ agent อื่น
        ↓
<repo>/GPT.md                 # บริบทเฉพาะ ChatGPT/Pilot ของ repo นี้
        ↓
คำสั่งปัจจุบันของผู้ใช้
```

`pnpm pilot setup` จะสร้าง `~/.pilot/GPT.md` ให้ครั้งแรกถ้ายังไม่มี และจะไม่เขียนทับไฟล์เดิม ส่วน `GPT.md` ที่ root ของ repo สามารถ commit ไปกับโปรเจกต์ได้ตามปกติ

ใช้ `context_info` เพื่อดูว่า Pilot โหลดไฟล์ใดอยู่ และใช้ `context_explain` เพื่อตามว่ากติกาหรือข้อความหนึ่งมาจาก source ไหน ในโหมด workspace ระบบจะไม่ไต่ขึ้นไปอ่าน `GPT.md` หรือ `AGENTS.md` นอกขอบเขตที่กำหนด

### 2. ThinkForge (`packages/thinkforge`)

ชุดเครื่องมือสำหรับคิดให้เป็นระบบก่อนลงมือแก้ปัญหาหรือเขียนโค้ด:

- `think_analyze_problem`: แตกปัญหา สมมติฐาน ข้อจำกัด และสิ่งที่ยังไม่รู้
- `think_generate_mechanisms`: สร้างทางเลือกที่อธิบายกลไกชัดเจน พร้อมวิธีพิสูจน์ว่าแนวคิดนั้นผิดได้
- `think_challenge_idea`: ทดสอบจุดอ่อนของแนวคิด หา failure mode ระบุหลักฐานที่ต้องมี และเงื่อนไขที่ควรหยุดใช้แนวทางนั้น
- `think_synthesize_ideas`: สังเคราะห์แนวคิดหลายทางโดยไม่กลบข้อขัดแย้งสำคัญ
- `think_experiment_design`: เปลี่ยนแนวคิดให้เป็นการทดลองขนาดเล็กที่ย้อนกลับได้และมีเกณฑ์ตัดสินชัดเจน
- `think_unconventional_solve`: รันกระบวนการตั้งแต่วิเคราะห์ปัญหาไปจนถึงออกแบบการทดลอง

### 3. Skill Hub (`packages/skill-hub`)

Skill Hub จัดการทักษะ 139 รายการใน `skills/` และโหลดรายละเอียดเฉพาะเมื่อจำเป็น แทนการยัดทุกอย่างเข้า context ตั้งแต่ต้น:

- ดูรายการทักษะและกรองตามงานผ่าน `skills_skill_list`
- อ่านขั้นตอนและคำแนะนำของทักษะผ่าน `skills_skill_read`
- ประกอบหลายทักษะเป็น workflow ผ่าน `skills_skill_compose`

### 4. Memory (`packages/memory`)

หน่วยความจำเก็บเป็น Markdown ใต้ `.pilot/memory/` เพื่อให้อ่าน ตรวจสอบ สำรอง และย้ายเครื่องได้ง่าย:

- **สารบัญหลัก (`TOC.md`)**: ดัชนีของหมวดหมู่ หัวข้อย่อย และบันทึกตามเวลา
- **สรุปภาพรวม (`SUMMARY.md`)**: สรุปบริบทของระบบ งานที่กำลังทำ และภาพรวมสถาปัตยกรรม
- **หมวดหมู่หลัก (`chapters/`)**:
  - `01-identity.md`: แนวทางการทำงานและมาตรฐานการพัฒนา
  - `02-projects.md`: รายการโปรเจกต์ โครงสร้าง และข้อมูลการทดสอบ
  - `03-architecture.md`: ข้อกำหนดสถาปัตยกรรมและหลักการออกแบบ
  - `04-timeline.md`: ลำดับเหตุการณ์สำคัญ
- **บันทึกตามช่วงเวลา (`timesteps/YYYY-MM-DD.md`)**: บันทึกเหตุการณ์ประจำวันเพื่อการค้นหาย้อนหลัง
- **การสร้างข้อมูลเริ่มต้นอัตโนมัติ (Self-Seeding)**: คัดลอกเทมเพลตจาก `packages/memory/seed/` อัตโนมัติเมื่อใช้งานบนระบบใหม่

## เครื่องมือที่ใช้บ่อย

### System / Machine

| ชื่อเครื่องมือ | หน้าที่ | พารามิเตอร์หลัก |
|---|---|---|
| `context_info` | ดูลำดับและเนื้อหา GPT.md / AGENTS.md ที่ Pilot โหลดอยู่ | `path`, `include_content` |
| `context_explain` | ตามที่มาของกติกาหรือข้อความใน context พร้อมลำดับความสำคัญ | `path`, `query` |
| `read_file` | อ่านเนื้อหาไฟล์แบบจำกัดขนาด พร้อมเลขบรรทัด | `path`, `offset`, `limit`, `expected_sha256` |
| `write_file` | เขียนหรือสร้างไฟล์ใหม่ พร้อมระบบป้องกันการเขียนทับ | `path`, `content`, `overwrite`, `expected_sha256` |
| `edit_file` | แก้ไขบล็อกข้อความแบบเจาะจง | `path`, `edits`, `expected_sha256` |
| `find_files` | ค้นหาไฟล์ด้วยรูปแบบ Glob | `pattern`, `root`, `max_depth` |
| `search_code` | ค้นหาข้อความหรือ Regex ผ่าน ripgrep | `query`, `path`, `case_sensitive` |
| `shell` | รันคำสั่ง shell ภายในขอบเขตโฟลเดอร์ | `command`, `timeout_ms`, `cwd` |
| `start_process` | เริ่มรันโปรเซสเบื้องหลัง | `command`, `cwd` |
| `read_process_output` | อ่าน stdout/stderr ที่อัปเดตใหม่ | `pid`, `process_id`, `stdout_offset` |
| `process_write` | ส่งข้อมูลเข้า stdin ของโปรเซส | `pid`, `process_id`, `input` |
| `process_wait` | รอจนกว่าโปรเซสจะเสร็จสิ้น | `pid`, `process_id`, `timeout_ms` |
| `git_status` | ตรวจสอบสถานะ Working Tree ของ Git | ไม่มี |
| `git_diff` | ดู diff ของไฟล์ที่แก้ไข | `paths`, `cached` |
| `git_commit_verified` | คอมมิตโค้ดหลังผ่านการตรวจสอบ build/test | `message`, `paths`, `profile` |
| `toolpy` | รันโค้ด Python ในเซสชัน IPython แบบคงสถานะ | `code`, `reset_session`, `allow_tools` |

### Memory

| ชื่อเครื่องมือ | หน้าที่ | พารามิเตอร์หลัก |
|---|---|---|
| `memory_toc` | เรียกดูสารบัญหลัก | ไม่มี |
| `memory_summary` | อ่านสรุปภาพรวมระบบหรือหมวดหมู่ | `chapter` (ไม่บังคับ) |
| `memory_read_topic` | อ่านเนื้อหาหมวดหมู่หรือหัวข้อย่อย | `topic`, `subtopic` |
| `memory_recall_time` | ค้นหาบันทึกตามวันที่หรือช่วงเวลา | `timestep` (`YYYY-MM-DD` หรือ `latest`) |
| `memory_search` | ค้นหาข้อความในไฟล์ Markdown ทั้งหมด | `query` |
| `memory_remember` | บันทึกข้อมูลใหม่ลงในไทม์ไลน์และอัปเดตดัชนี | `title`, `content`, `tags` |
| `memory_stats` | แสดงสถิติจำนวนไฟล์ คำ และขนาดข้อมูล | ไม่มี |
| `memory_recall` | เรียกดูข้อมูลแบบรวม (ค้นหาตามคำ, หัวข้อ, หรือเวลา) | `query`, `topic`, `timestep` |

### ThinkForge / Skill Hub

| ชื่อเครื่องมือ | หน้าที่ | พารามิเตอร์หลัก |
|---|---|---|
| `think_analyze_problem` | วิเคราะห์ปัญหา สมมติฐาน และข้อจำกัด | `problem`, `objective`, `constraints` |
| `think_reframe_problem` | จัดกรอบปัญหาใหม่ด้วยวิธีคิดที่เลือก | `problem`, `methods` |
| `think_generate_mechanisms` | สร้างทางเลือกเชิงกลไก | `problem`, `objective`, `methods` |
| `think_challenge_idea` | ทดสอบจุดอ่อนของแนวคิด หา failure mode และเกณฑ์ที่ควรหยุด | `idea`, `objective`, `assumptions` |
| `think_synthesize_ideas` | สังเคราะห์แนวคิดที่แข่งขันกัน | `problem`, `ideas`, `objective` |
| `think_experiment_design` | ออกแบบการทดลองเพื่อพิสูจน์หรือหักล้างแนวคิด | `idea`, `objective`, `constraint` |
| `think_unconventional_solve` | รันกระบวนการคิดครบตั้งแต่วิเคราะห์จนถึงออกแบบการทดลอง | `problem`, `objective`, `constraints`, `methods` |
| `skills_skill_list` | ดูรายการทักษะที่มีในระบบ | `filter`, `limit` |
| `skills_skill_read` | อ่านขั้นตอนการทำงานของทักษะ | `name` |
| `skills_skill_compose` | ประกอบ workflow จากทักษะที่เลือก | `name`, `parameters` |

## การตั้งค่า

สามารถกำหนดค่าการทำงานผ่านอาร์กิวเมนต์หรือตัวแปรสภาพแวดล้อม:

| อาร์กิวเมนต์ | ตัวแปรสภาพแวดล้อม | ค่าเริ่มต้น | รายละเอียด |
|---|---|---|---|
| `--root` | `MCP_WORKSPACE_ROOT` | โฟลเดอร์ปัจจุบัน | โฟลเดอร์รากที่ใช้จำกัดขอบเขตการเข้าถึง |
| `--tool-surface` | `MCP_TOOL_SURFACE` | `legacy` | รูปแบบการเปิดเผยเครื่องมือ: `legacy` (แยกเป็นราย tool) หรือ `hybrid` (`toolpy` + registry) |
| `--dangerously-open-machine` | `MCP_ACCESS_MODE` | `workspace` | อนุญาตให้เข้าถึงระบบไฟล์และเชลล์นอกโฟลเดอร์หลัก |
| `--policy` | `MCP_POLICY` | `admin` | นโยบายความปลอดภัย: `admin`, `developer`, หรือ `readonly` |
| `--approval-mode` | `MCP_APPROVAL_MODE` | `mrtr` | พฤติกรรมเมื่อเครื่องมือต้องขออนุมัติ: `mrtr` (ส่งคำขออนุมัติ) หรือ `deny` |
| `--audit-file` | `MCP_AUDIT_FILE` | `.pilot/audit.ndjson` | ไฟล์บันทึกประวัติการเรียกใช้เครื่องมือ |
| `--max-timeout` | `MCP_SUPERVISOR_TIMEOUT_MS` | `600000` | timeout สูงสุดของเครื่องมือ (มิลลิวินาที) |

## ความปลอดภัย

- **การจำกัดขอบเขตระบบไฟล์**: ในโหมด Workspace การอ่าน เขียน และค้นหาจะทำได้เฉพาะภายใต้ `--root` เท่านั้น และระบบจะปฏิเสธ symlink ที่ชี้ออกนอกขอบเขต
- **การควบคุมโปรเซส**: โปรเซสเบื้องหลังทั้งหมดอยู่ภายใต้ Supervisor พร้อม Circuit Breaker เพื่อหยุดการเรียกซ้ำเมื่อเกิดอาการค้างหรือขัดข้องต่อเนื่อง
- **การตรวจสอบความถูกต้องก่อนคอมมิต**: `git_commit_verified` ตรวจ SHA-256 ของไฟล์ก่อนและหลังการทดสอบ เพื่อป้องกันการคอมมิตจาก working tree ที่เปลี่ยนไประหว่างตรวจสอบ
- **บันทึกประวัติการทำงาน**: ทุกคำสั่งและผลลัพธ์จะถูกบันทึกลงในไฟล์ `.pilot/audit.ndjson` โดยอัตโนมัติ ข้อมูลลับ เช่น token, private key และ `.env` จะถูกกรองและปิดบังก่อนบันทึกหรือส่งออก

## การพัฒนา

```bash
# ตรวจสอบ TypeScript ทั้งหมด
pnpm typecheck

# รันชุดทดสอบ
pnpm test

# คอมไพล์โปรเจกต์
pnpm build

# ตรวจสอบความถูกต้องก่อนคอมมิต
pnpm verify
```

## สัญญาอนุญาต

โปรเจกต์นี้เผยแพร่ภายใต้ MIT License ดูรายละเอียดในไฟล์ [LICENSE](LICENSE)
