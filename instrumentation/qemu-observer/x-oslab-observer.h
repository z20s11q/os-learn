/*
 * x-oslab-observer.h —— 观察扩展在 QEMU 内部的注册入口。
 *
 * 由 monitor/qmp-cmds.c 的 monitor_init_qmp_commands() 在 qmp_init_marshal()
 * 之后调用。顺序很重要：qmp_init_marshal() 内部执行 QTAILQ_INIT(&qmp_commands)，
 * 任何早于它的注册都会被清掉，因此不能用独立的 __attribute__((constructor))
 * 注册这些命令。
 */

#ifndef X_OSLAB_OBSERVER_H
#define X_OSLAB_OBSERVER_H

#include "qapi/qmp/dispatch.h"

void x_oslab_init_commands(QmpCommandList *cmds);

#endif /* X_OSLAB_OBSERVER_H */
