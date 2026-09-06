<p align="center">
  <img src="docs/assets/mcp-tunnel-meme.png" alt="ChatGPT, OpenAI, and MCP Tunnel" width="750">
</p>

# ChatGPT Pilot (คู่มือภาษาไทย)

[![CI/CD](https://github.com/JonusNattapong/chatgpt-pilot/actions/workflows/ci.yml/badge.svg)](https://github.com/JonusNattapong/chatgpt-pilot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![pnpm](https://img.shields.io/badge/pnpm-workspace-orange.svg)](pnpm-workspace.yaml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Model Context Protocol](https://img.shields.io/badge/MCP-2.0-purple.svg)](https://modelcontextprotocol.io/)

ChatGPT Pilot เป็นเซิร์ฟเวอร์ Model Context Protocol (MCP) ระดับเครื่องโลคอลที่รวบรวมเครื่องมือสั่งการระบบ, การจัดการหน่วยความจำ, และกระบวนการวิเคราะห์สำหรับเชื่อมต่อกับ ChatGPT, Codex และไคลเอนต์ MCP อื่นๆ

ระบบเชื่อมโยง 4 ความสามารถหลักเข้าด้วยกันผ่านการเชื่อมต่อ MCP เดียว:

- **การทำงานกับระบบเครื่อง (`apps/server`)**: จัดการไฟล์แบบกำหนดขอบเขต, ควบคุมโปรเซสเบื้องหลัง, ตรวจสอบความถูกต้องของ Git ก่อนคอมมิต, และรันโค้ด Python แบบ Stateful ผ่าน `toolpy`
- **เครื่องมือช่วยคิดและวิเคราะห์ (`packages/thinkforge`)**: เครื่องมือสำหรับวิเคราะห์ปัญหา, ท้าทายสมมติฐาน, จัดกรอบมุมมองใหม่, และจำลองสภาวะขัดข้องของระบบ
- **คลังกระบวนการทำงาน (`packages/skill-hub`)**: ค้นหาและเรียกใช้งานเวิร์กโฟลว์เฉพาะทาง139 รายการจากโฟลเดอร์ `skills/`
- **ระบบจัดเก็บหน่วยความจำ Markdown (`packages/memory`)**: จัดเก็บข้อมูล, บันทึกการตัดสินใจทางสถาปัตยกรรม, และไทม์ไลน์ในรูปแบบไฟล์ Markdown มาตรฐาน โดยไม่พึ่งพาฐานข้อมูลไบนารีหรือ Native C++

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

## ความต้องการของระบบ

- **Node.js**: เวอร์ชั่น `22.0.0` ขึ้นไป
- **pnpm**: เวอร์ชั่น `9.x` หรือ `10.x`
- **Git**: เวอร์ชั่น `2.30.0` ขึ้นไป
- **Python**: เวอร์ชั่น `3.10` ขึ้นไปพร้อม `ipykernel` (จำเป็นเฉพาะเมื่อใช้งาน `toolpy`)

## การเริ่มต้นใช้งาน

### 1. โคลนคลังโค้ดและติดตั้งส่วนประกอบ

```bash
git clone https://github.com/JonusNattapong/chatgpt-pilot.git
cd chatgpt-pilot
pnpm install
```

### 2. คอมไพล์แพ็กเกจ

```bash
pnpm build
```

### 3. ตรวจสอบการทำงาน

รันชุดทดสอบเพื่อยืนยันว่าการทำงานข้ามแพลตฟอร์มผ่านเกณฑ์ทั้งหมด:

```bash
# รันชุดทดสอบปัจจุบันของทุก workspace package
pnpm test

# ตรวจสอบ Hybrid Capability Surface
pnpm check:hybrid
```

### 4. เชื่อมต่อกับไคลเอนต์ MCP

#### โหมด Stdio (Claude Desktop, Antigravity หรือ CLI โลคอล)

เพิ่มการตั้งค่าลงในไฟล์คอนฟิกของไคลเอนต์:

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

เชื่อมต่อผ่านทันเนลสำหรับนักพัฒนาของ OpenAI:

- **Windows (PowerShell)**:
  ```powershell
  .\scripts\start-tunnel.ps1
  ```
- **Linux / macOS (Bash)**:
  ```bash
  ./scripts/start-tunnel.sh
  ```

ตรวจสอบสถานะ วินิจฉัย รีสตาร์ต หรือหยุดการทำงานของทันเนล:

```bash
# ตรวจสอบสถานะทันเนล
.\scripts\status-tunnel.ps1   # Windows
./scripts/status-tunnel.sh    # Linux/macOS

# หยุดการทำงานของทันเนล
.\scripts\stop-tunnel.ps1     # Windows
./scripts/stop-tunnel.sh      # Linux/macOS
```

### Control plane สำหรับ self-diagnosis / self-healing

```text
runtime_info -> ตรวจ build/HEAD/worker/fingerprint
capability_diff -> เทียบ live worker กับ fresh build probe
restart_if_stale -> restart เฉพาะเมื่อพิสูจน์ได้ว่า worker stale
self_update -> ff-only origin/main -> build -> verify -> supervised restart -> handshake
```

`self_update` ต้องเปิด `MCP_ALLOW_SELF_UPDATE=1` และจะ fail closed เมื่อ working tree ไม่ clean, ไม่ได้อยู่ `main`, มี unpushed commit หรือ branch divergence

## โมดูลหลัก

### 1. การทำงานกับระบบเครื่อง (`apps/server`)

เซิร์ฟเวอร์หลักควบคุมการเข้าถึงระบบไฟล์และโปรเซสด้วยมาตรการจำกัดขอบเขต:

- **เครื่องมือจัดการไฟล์**: อ่านและแก้ไขไฟล์แบบ Transactional พร้อมตรวจเช็คความถูกต้องด้วย SHA-256 (`read_file`, `write_file`, `edit_file`, `find_files`, `search_code`)
- **การจัดการโปรเซส**: ควบคุมโปรเซสเบื้องหลังด้วย Supervisor ติดตามเอาต์พุตแบบสตรีมและหยุดโปรเซสได้อย่างสมบูรณ์ (`start_process`, `read_process_output`, `process_write`, `process_wait`, `stop_process`)
- **การตรวจสอบ Git ก่อนคอมมิต**: `git_commit_verified` รันคำสั่งตรวจสอบ (`test`, `build`) บน Index ชั่วคราว หากไม่ผ่านหรือมีการแก้ไขไฟล์นอกเหนือคำสั่ง การคอมมิตจะถูกยกเลิกทันที
- **Persistent Python (`toolpy`)**: เซสชัน IPython แบบคงสถานะ ช่วยเก็บตัวแปรข้ามคำสั่งและเรียกใช้ความสามารถของ MCP ผ่านฟังก์ชัน Python

### 2. เครื่องมือช่วยคิดและวิเคราะห์ (`packages/thinkforge`)

โครงสร้างขั้นตอนการวิเคราะห์เพื่อช่วยโมเดลประเมินความเสี่ยงก่อนลงมือเขียนโค้ด:

- `think_analyze_problem`: แตกปัญหา สมมติฐาน ข้อจำกัด และสิ่งที่ยังไม่รู้
- `think_generate_mechanisms`: สร้างทางเลือกเชิงกลไกพร้อม falsification test
- `think_challenge_idea`: ทดสอบ failure mode หลักฐานที่ต้องใช้ และ kill criteria
- `think_synthesize_ideas`: รวมแนวคิดที่แข่งขันกันโดยเก็บข้อขัดแย้งไว้
- `think_experiment_design`: แปลงแนวคิดเป็นการทดลองที่ rollback ได้
- `think_unconventional_solve`: orchestrate analysis ถึง experiment แบบครบวงจร

### 3. คลังกระบวนการทำงาน (`packages/skill-hub`)

ศูนย์รวมขั้นตอนการทำงานสำเร็จรูป139 รายการในไดเรกทอรี `skills/`:

- ค้นหารายการเวิร์กโฟลว์ผ่าน `skills_skill_list`
- ดึงคำแนะนำขั้นตอนการทำงานอย่างละเอียดผ่าน `skills_skill_read`
- เรียกประมวลผลกระบวนการผ่าน `skills_skill_compose`

### 4. ระบบจัดเก็บหน่วยความจำ Markdown (`packages/memory`)

ระบบจัดการข้อมูลความจำแบบไฟล์ Markdown ภายใต้โฟลเดอร์ `.pilot/memory/`:

- **สารบัญหลัก (`TOC.md`)**: ดัชนีระบุหมวดหมู่ หัวข้อย่อย และบันทึกเวลา
- **สรุปภาพรวม (`SUMMARY.md`)**: สรุปบริบทของระบบ งานที่กำลังดำเนินอยู่ และรูปแบบสถาปัตยกรรม
- **หมวดหมู่หลัก (`chapters/`)**:
  - `01-identity.md`: แนวทางการทำงานและมาตรฐานการพัฒนา
  - `02-projects.md`: รายการโปรเจกต์ โครงสร้าง และข้อมูลการทดสอบ
  - `03-architecture.md`: ข้อกำหนดสถาปัตยกรรมและหลักการออกแบบ
  - `04-timeline.md`: ลำดับเหตุการณ์สำคัญ
- **บันทึกตามช่วงเวลา (`timesteps/YYYY-MM-DD.md`)**: บันทึกเหตุการณ์ประจำวันเพื่อการค้นหาย้อนหลัง
- **การตั้งค่าเริ่มต้นอัตโนมัติ (Self-Seeding)**: คัดลอกเทมเพลตเริ่มต้นจาก `packages/memory/seed/` ให้อัตโนมัติเมื่อติดตั้งบนระบบใหม่

## ตารางอ้างอิงเครื่องมือ (Tool Reference)

### เครื่องมือควบคุมระบบ

| ชื่อเครื่องมือ | หน้าที่ | พารามิเตอร์หลัก |
|---|---|---|
| `read_file` | อ่านเนื้อหาไฟล์แบบจำกัดขนาด พร้อมเลขบรรทัด | `path`, `offset`, `limit`, `expected_sha256` |
| `write_file` | เขียนหรือสร้างไฟล์ใหม่ พร้อมระบบป้องกันการเขียนทับ | `path`, `content`, `overwrite`, `expected_sha256` |
| `edit_file` | แก้ไขบล็อกข้อความแบบเจาะจง | `path`, `edits`, `expected_sha256` |
| `find_files` | ค้นหาไฟล์ตามรูปแบบ Glob | `pattern`, `root`, `max_depth` |
| `search_code` | ค้นหาข้อความหรือ Regex ผ่าน ripgrep | `query`, `path`, `case_sensitive` |
| `shell` | รันคำสั่งเชลล์ภายในขอบเขตโฟลเดอร์ | `command`, `timeout_ms`, `cwd` |
| `start_process` | เริ่มรันโปรเซสเบื้องหลัง | `command`, `cwd` |
| `read_process_output` | อ่าน stdout/stderr ที่อัปเดตใหม่ | `pid`, `process_id`, `stdout_offset` |
| `process_write` | ส่งข้อมูลเข้า stdin ของโปรเซส | `pid`, `process_id`, `input` |
| `process_wait` | รอจนกว่าโปรเซสจะเสร็จสิ้น | `pid`, `process_id`, `timeout_ms` |
| `git_status` | ตรวจสอบสถานะ Working Tree ของ Git | ไม่มี |
| `git_diff` | ดู Diff เนื้อหาที่แก้ไข | `paths`, `cached` |
| `git_commit_verified` | คอมมิตโค้ดหลังจากผ่านการทดสอบ Build/Test | `message`, `paths`, `profile` |
| `toolpy` | รันโค้ด Python ในเซสชัน IPython แบบคงสถานะ | `code`, `reset_session`, `allow_tools` |

### เครื่องมือหน่วยความจำ

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

### เครื่องมือช่วยคิดและคลังทักษะ

| ชื่อเครื่องมือ | หน้าที่ | พารามิเตอร์หลัก |
|---|---|---|
| `think_analyze_problem` | วิเคราะห์ปัญหา สมมติฐาน และข้อจำกัด | `problem`, `objective`, `constraints` |
| `think_reframe_problem` | จัดกรอบปัญหาผ่านวิธีคิดที่เลือก | `problem`, `methods` |
| `think_generate_mechanisms` | สร้างทางเลือกเชิงกลไก | `problem`, `objective`, `methods` |
| `think_challenge_idea` | challenge แนวคิดและกำหนด kill criteria | `idea`, `objective`, `assumptions` |
| `think_synthesize_ideas` | สังเคราะห์แนวคิดที่แข่งขันกัน | `problem`, `ideas`, `objective` |
| `think_experiment_design` | ออกแบบ falsification experiment | `idea`, `objective`, `constraint` |
| `think_unconventional_solve` | รัน reasoning pipeline แบบครบวงจร | `problem`, `objective`, `constraints`, `methods` |
| `skills_skill_list` | เรียกดูรายการทักษะที่มีในระบบ | `filter`, `limit` |
| `skills_skill_read` | ดึงขั้นตอนการปฏิบัติงานของทักษะ | `name` |
| `skills_skill_compose` | ดำเนินการตามขั้นตอนของทักษะ | `name`, `parameters` |

## การตั้งค่า

สามารถกำหนดค่าการทำงานผ่านอาร์กิวเมนต์หรือตัวแปรสภาพแวดล้อม:

| อาร์กิวเมนต์ | ตัวแปรสภาพแวดล้อม | ค่าเริ่มต้น | รายละเอียด |
|---|---|---|---|
| `--root` | `MCP_WORKSPACE_ROOT` | โฟลเดอร์ปัจจุบัน | โฟลเดอร์หลักสำหรับจำกัดขอบเขตความปลอดภัย |
| `--tool-surface` | `MCP_TOOL_SURFACE` | `legacy` | รูปแบบเครื่องมือ: `legacy` (แยกรายตัว) หรือ `hybrid` (`toolpy` + registry) |
| `--dangerously-open-machine` | `MCP_ACCESS_MODE` | `workspace` | อนุญาตให้เข้าถึงระบบไฟล์และเชลล์นอกโฟลเดอร์หลัก |
| `--policy` | `MCP_POLICY` | `admin` | นโยบายความปลอดภัย: `admin`, `developer`, หรือ `readonly` |
| `--approval-mode` | `MCP_APPROVAL_MODE` | `mrtr` | การจัดการเมื่อต้องขอสิทธิ์: `mrtr` (รออนุมัติ) หรือ `deny` |
| `--audit-file` | `MCP_AUDIT_FILE` | `.pilot/audit.ndjson` | ไฟล์บันทึกประวัติการเรียกใช้เครื่องมือ |
| `--max-timeout` | `MCP_SUPERVISOR_TIMEOUT_MS` | `600000` | เวลาหมดอายุสูงสุดของเครื่องมือ (มิลลิวินาที) |

## ความปลอดภัยและการกำกับดูแล

- **การจำกัดขอบเขตระบบไฟล์**: ในโหมด Workspace การอ่าน เขียน และค้นหาจะถูกจำกัดอยู่ภายใต้ `--root` เท่านั้น หากมี Symlink ชี้ออกไปภายนอกจะถูกปฏิเสธ
- **การควบคุมโปรเซส**: ทุกโปรเซสเบื้องหลังถูกจัดการโดย Supervisor Daemon พร้อมระบบตัดการทำงานอัตโนมัติ (Circuit Breaker) เมื่อโปรเซสค้างหรือขัดข้องต่อเนื่อง
- **การตรวจสอบความถูกต้องก่อนคอมมิต**: `git_commit_verified` ตรวจสอบลายนิ้วมือ SHA-256 ของไฟล์ก่อนและหลังการทดสอบ เพื่อป้องกันไฟล์ถูกแก้ไขโดยไม่ตั้งใจ
- **บันทึกประวัติการทำงาน**: ทุกคำสั่งและผลลัพธ์จะถูกบันทึกลงในไฟล์ `.pilot/audit.ndjson` โดยอัตโนมัติ ข้อมูลความลับ (Tokens, Private Keys, `.env`) จะถูกคัดกรองและเซ็นเซอร์ก่อนบันทึกหรือส่งออกเสมอ

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

โปรเจกต์นี้เผยแพร่ภายใต้สัญญาอนุญาต MIT ดูรายละเอียดในไฟล์ [LICENSE](LICENSE)
