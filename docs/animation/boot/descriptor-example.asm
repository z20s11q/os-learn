; GDTR / IDTR teaching example, NASM syntax.
; Assemble: nasm -f bin descriptor-example.asm -o descriptor-example.bin
; This is a payload for a protected-mode loader, NOT a boot sector or a Windows EXE.
; Load the complete image at physical 0x10000 and enter CS:EIP = 0x08:0x10000.
; Preconditions established by the loader:
;   CPL=0, CR0.PE=1, CR0.PG=0, readable 32-bit CS with base=0, limit=0xFFFFFFFF;
;   SS=0x10, cached base=0x20000, limit=0xFFFF, B=1; ESP=0xFF00;
;   DS=0 (null), EBX=0, EFLAGS=0x2. An existing GDT supports CS and SS.
;   The new GDT below describes the same CS and SS. LGDT preserves their caches.
;   Only software INT 0x21 is demonstrated; all other IDT entries are absent.
; Data declarations are emitted into the image by NASM and loaded into RAM.
; They are not CPU instructions. Padding fixes addresses for the teaching diagram.

; @section format
BITS 32                       ; 本例按 32 位编码指令
ORG 0x10000
; @end
LOAD_BASE equ 0x10000
HANDLER equ 0x12340

; @section start
start:
    cli                       ; 关闭可屏蔽硬件中断
    lgdt [cs:gdt_ptr]          ; 读 6 字节，装入 GDTR
    mov ax, 0x10              ; 选择 GDT[2]
    mov ds, ax                ; 查 GDT，装载 DS 缓存
    mov ax, [ds:0x10]          ; 读物理 0x20010，AX = 7
    jmp 0x08:after_cs          ; 查 GDT[1]，重装 CS
; @end

times 0x10100 - (LOAD_BASE + $ - $$) db 0
; @section interrupt
after_cs:
    lidt [cs:idt_ptr]          ; 读 6 字节，装入 IDTR
    int 0x21                  ; CPU 查 IDT[0x21]
resume:
    hlt                       ; 返回这里时 EBX = 1
    jmp resume
; @end

times HANDLER - (LOAD_BASE + $ - $$) db 0
; @section handler
handler:                      ; 地址 0x12340
    inc ebx                   ; EBX 从 0 变成 1
    iretd                     ; 弹出 EIP、CS、EFLAGS
; @end

times 0x20010 - (LOAD_BASE + $ - $$) db 0
; @section data
value: dw 7                   ; 物理地址 0x20010
; @end

times 0x50000 - (LOAD_BASE + $ - $$) db 0
; @section gdt
gdt:                          ; 地址 0x50000
    dq 0                      ; GDT[0]：空项
    dq 0x00CF9A000000FFFF     ; GDT[1]：代码段，基址 0
data_descriptor:              ; GDT[2]：地址 0x50010
    dw 0xFFFF, 0x0000         ; 段界限低 16 位、基址低 16 位
    db 0x02, 0x92             ; 基址中 8 位、权限
    db 0x40, 0x00             ; 标志、基址高 8 位
gdt_end:
; @end

times 0x52000 - (LOAD_BASE + $ - $$) db 0
; @section gdt_ptr
gdt_ptr:                      ; 记录自身在 0x52000
    dw gdt_end - gdt - 1       ; 2 字节：limit = 0x17
    dd gdt                    ; 4 字节：base = 0x50000
; @end

times 0x52010 - (LOAD_BASE + $ - $$) db 0
; @section idt_ptr
idt_ptr:                      ; 记录自身在 0x52010
    dw idt_end - idt - 1       ; limit = 0x7FF
    dd idt                    ; base = 0x60000
; @end

times 0x60000 - (LOAD_BASE + $ - $$) db 0
; @section idt
idt:                          ; 地址 0x60000
    times 0x21 dq 0           ; 前 33 项留空
gate21:                       ; 第 33 项：0x60108
    dw HANDLER & 0xFFFF       ; 入口偏移低 16 位：0x2340
    dw 0x08                   ; 代码段选择子：GDT[1]
    db 0, 0x8E                ; 保留字节、32 位中断门属性
    dw HANDLER >> 16          ; 入口偏移高 16 位：0x0001
    times (256 - 0x22) dq 0   ; 剩余表项留空
idt_end:
; @end
