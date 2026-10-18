# T07b 的独立对照实现（GDB 侧）。
#
# 类型与偏移由 GDB 的 DWARF 解释，per-CPU 寻址以 CPU 的 %gs 基址为起点。
# 逐字段结果与解析器的布局清单、__per_cpu_offset[] 寻址结果独立对照。
# Node 侧生成输出路径后将脚本 source 进 GDB，结果写入 JSON 文件。
#
# 用法：gdb 里 `source t07b-gdb-reference.py`；输出路径写在文件里的 OUT_PATH。

import json
import traceback

import gdb

OUT_PATH = __OUT_PATH__
MAX_TASKS = 4096
MASK64 = (1 << 64) - 1


def u64(value):
    """将 GDB 的有符号寄存器值按掩码归一为无符号 64 位地址。"""
    return value & MASK64


def u64_at(address):
    """从原始内存字节读取 8 字节小端整数。"""
    inferior = gdb.selected_inferior()
    raw = inferior.read_memory(int(address), 8).tobytes()
    return int.from_bytes(raw, byteorder="little", signed=False)


def field_offset(type_name, field_path):
    """由 GDB 的 DWARF 计算字段偏移这一编译期常量。"""
    return int(gdb.parse_and_eval("(unsigned long)&((%s *)0)->%s" % (type_name, field_path)))


def safe(read, default=None):
    try:
        return read()
    except Exception:
        return default


def read_task(task_pointer, task_type, offsets):
    """将 task_struct 读成字典，各字段独立读取，失败字段使用缺省值。"""
    task = task_pointer.dereference()
    record = {"address": int(task_pointer)}
    record["pid"] = safe(lambda: int(task["pid"]))
    record["tgid"] = safe(lambda: int(task["tgid"]))
    record["comm"] = safe(lambda: task["comm"].string(errors="replace"))
    record["rawState"] = safe(lambda: int(task["__state"]))
    record["rawExitState"] = safe(lambda: int(task["exit_state"]))
    record["exitCode"] = safe(lambda: int(task["exit_code"]))
    record["flags"] = safe(lambda: int(task["flags"]))
    record["mm"] = safe(lambda: int(task["mm"]))
    record["activeMm"] = safe(lambda: int(task["active_mm"]))
    record["stack"] = safe(lambda: int(task["stack"]))
    record["realParent"] = safe(lambda: int(task["real_parent"]))
    record["parent"] = safe(lambda: int(task["parent"]))
    record["groupLeader"] = safe(lambda: int(task["group_leader"]))
    record["threadPid"] = safe(lambda: int(task["thread_pid"]))
    record["signal"] = safe(lambda: int(task["signal"]))
    record["files"] = safe(lambda: int(task["files"]))
    record["cred"] = safe(lambda: int(task["cred"]))
    record["nsproxy"] = safe(lambda: int(task["nsproxy"]))
    record["onCpu"] = safe(lambda: int(task["thread_info"]["cpu"]))
    record["prio"] = safe(lambda: int(task["prio"]))
    record["staticPrio"] = safe(lambda: int(task["static_prio"]))
    record["normalPrio"] = safe(lambda: int(task["normal_prio"]))
    record["rtPriority"] = safe(lambda: int(task["rt_priority"]))
    record["policy"] = safe(lambda: int(task["policy"]))
    record["utime"] = safe(lambda: int(task["utime"]))
    record["stime"] = safe(lambda: int(task["stime"]))
    record["startTime"] = safe(lambda: int(task["start_time"]))
    record["nvcsw"] = safe(lambda: int(task["nvcsw"]))
    record["nivcsw"] = safe(lambda: int(task["nivcsw"]))
    record["vruntime"] = safe(lambda: int(task["se"]["vruntime"]))
    # 单独读取 real_parent 的 pid，与父任务地址共同核对父子关系。
    record["realParentPid"] = safe(lambda: int(task["real_parent"].dereference()["pid"]))
    record["parentPid"] = safe(lambda: int(task["parent"].dereference()["pid"]))
    # 子进程列表：由 GDB 自己走 sibling 链表。
    record["children"] = safe(lambda: walk_children(task, offsets), [])
    # 线程组：由 GDB 自己走 signal_struct.thread_head。
    record["threads"] = safe(lambda: walk_threads(task, offsets), [])
    record["_offsetsUsed"] = offsets
    return record


def walk_children(task, offsets):
    """沿 task->children（成员是 sibling）走一遍，返回子任务的地址。"""
    sibling_offset = offsets["sibling"]
    head = int(task["children"].address)
    cursor = int(task["children"]["next"])
    list_type = gdb.lookup_type("struct list_head").pointer()
    out = []
    seen = set()
    while cursor != head and cursor != 0 and len(out) < MAX_TASKS:
        if cursor in seen:
            break
        seen.add(cursor)
        # cursor 是"下一个任务的 sibling 成员"的地址，所以结构地址要减掉 sibling 偏移。
        out.append(cursor - sibling_offset)
        cursor = int(gdb.Value(cursor).cast(list_type).dereference()["next"])
    return out


def walk_threads(task, offsets):
    """沿 signal_struct.thread_head（成员是 thread_node）走一遍，返回线程地址。"""
    signal = safe(lambda: int(task["signal"]))
    if not signal:
        return []
    thread_node_offset = offsets["thread_node"]
    thread_head_offset = offsets["signal_struct_thread_head"]
    head = signal + thread_head_offset
    list_type = gdb.lookup_type("struct list_head").pointer()
    cursor = int(gdb.Value(head).cast(list_type).dereference()["next"])
    out = []
    seen = set()
    while cursor != head and cursor != 0 and len(out) < MAX_TASKS:
        if cursor in seen:
            break
        seen.add(cursor)
        out.append(cursor - thread_node_offset)
        cursor = int(gdb.Value(cursor).cast(list_type).dereference()["next"])
    return out


def walk_task_list(offsets, limit):
    """从 init_task 出发走完整条进程链表（GDB 侧实现），返回结果与截断/成环标记。"""
    init_task = gdb.parse_and_eval("init_task").address
    tasks_offset = offsets["tasks"]
    head = int(init_task) + tasks_offset
    list_type = gdb.lookup_type("struct list_head").pointer()
    cursor = int(gdb.Value(head).cast(list_type).dereference()["next"])
    addresses = []
    seen = set()
    truncated = False
    cycle = False
    while cursor != head and cursor != 0:
        if cursor in seen:
            cycle = True
            break
        if len(addresses) >= limit:
            truncated = True
            break
        seen.add(cursor)
        addresses.append(cursor - tasks_offset)
        cursor = int(gdb.Value(cursor).cast(list_type).dereference()["next"])
    return {
        "initTask": int(init_task),
        "addresses": addresses,
        "truncated": truncated,
        "cycle": cycle,
    }


def main():
    result = {"ok": True, "notes": []}
    try:
        task_type = gdb.lookup_type("struct task_struct")
        offsets = {
            "tasks": field_offset("struct task_struct", "tasks"),
            "sibling": field_offset("struct task_struct", "sibling"),
            "thread_node": field_offset("struct task_struct", "thread_node"),
            "signal_struct_thread_head": field_offset("struct signal_struct", "thread_head"),
            "pcpu_hot_current": field_offset("struct pcpu_hot", "current_task"),
        }
        result["offsets"] = offsets

        # ---------- per-CPU：两条独立机制求 current ----------
        gs_base = safe(lambda: u64(int(gdb.parse_and_eval("$gs_base"))))
        result["gsBase"] = gs_base
        percpu_offset_0 = safe(lambda: u64(int(gdb.parse_and_eval("__per_cpu_offset[0]"))))
        result["percpuOffset0"] = percpu_offset_0
        pcpu_hot_link = safe(lambda: u64(int(gdb.parse_and_eval("(unsigned long)&pcpu_hot"))))
        result["pcpuHotLinkAddress"] = pcpu_hot_link
        runqueues_link = safe(lambda: u64(int(gdb.parse_and_eval("(unsigned long)&runqueues"))))
        result["runqueuesLinkAddress"] = runqueues_link

        # 把"基址 + 链接地址"的结果记下来：出问题时第一步就能看出是地址算错还是读不动。
        current_address_gs = None if (gs_base is None or pcpu_hot_link is None) else u64(gs_base + pcpu_hot_link)
        current_address_percpu = None if (percpu_offset_0 is None or pcpu_hot_link is None) \
            else u64(percpu_offset_0 + pcpu_hot_link)
        result["probe"] = {
            "currentAddressFromGsBase": current_address_gs,
            "currentAddressFromPercpuOffset": current_address_percpu,
        }

        if current_address_gs is not None:
            result["currentFromGsBase"] = safe(lambda: u64_at(current_address_gs))
        # 同一条公式的第二来源：per-CPU 基址数组（我的解析器用的就是这条）。
        if current_address_percpu is not None:
            result["currentFromPercpuOffset"] = safe(lambda: u64_at(current_address_percpu))

        # ---------- 进程链表 ----------
        walked = walk_task_list(offsets, MAX_TASKS)
        result["list"] = walked
        tasks = []
        try:
            tasks.append(read_task(gdb.Value(walked["initTask"]).cast(task_type.pointer()), task_type, offsets))
        except Exception as exc:  # init_task 读取失败时记录原因，继续处理任务列表。
            result["notes"].append("读 init_task 失败：%s" % exc)
        for address in walked["addresses"]:
            try:
                tasks.append(read_task(gdb.Value(address).cast(task_type.pointer()), task_type, offsets))
            except Exception as exc:  # 单个任务读取失败时记录原因，继续处理其余任务。
                result["notes"].append("读任务 0x%x 失败：%s" % (address, exc))
        result["tasks"] = tasks

        # ---------- 运行队列 ----------
        if percpu_offset_0 is not None and runqueues_link is not None:
            rq_address = u64(percpu_offset_0 + runqueues_link)
            rq_type = gdb.lookup_type("struct rq")
            rq = gdb.Value(rq_address).cast(rq_type.pointer()).dereference()
            result["runqueue"] = {
                "address": rq_address,
                "nrRunning": safe(lambda: int(rq["nr_running"])),
                "cfsNrRunning": safe(lambda: int(rq["cfs"]["nr_running"])),
                "rtNrRunning": safe(lambda: int(rq["rt"]["rt_nr_running"])),
                "dlNrRunning": safe(lambda: int(rq["dl"]["dl_nr_running"])),
                "nrSwitches": safe(lambda: int(rq["nr_switches"])),
                "curr": safe(lambda: int(rq["curr"])),
                "idle": safe(lambda: int(rq["idle"])),
                "cpuField": safe(lambda: int(rq["cpu"])),
            }
    except Exception as exc:
        result["ok"] = False
        result["error"] = "%s: %s" % (type(exc).__name__, exc)
        result["traceback"] = traceback.format_exc().splitlines()[-6:]

    with open(OUT_PATH, "w") as handle:
        json.dump(result, handle)
    gdb.write("[t07b] 对照数据已写入 %s\n" % OUT_PATH)


main()
