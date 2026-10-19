// Generated from descriptor-example.asm by scripts/build-descriptor-example.mjs.
export const ASSEMBLY = {
  "format": [
    {
      "n": 15,
      "t": "BITS 32                       ; 本例按 32 位编码指令"
    },
    {
      "n": 16,
      "t": "ORG 0x10000"
    }
  ],
  "start": [
    {
      "n": 22,
      "t": "start:"
    },
    {
      "n": 23,
      "t": "    cli                       ; 关闭可屏蔽硬件中断"
    },
    {
      "n": 24,
      "t": "    lgdt [cs:gdt_ptr]          ; 读 6 字节，装入 GDTR"
    },
    {
      "n": 25,
      "t": "    mov ax, 0x10              ; 选择 GDT[2]"
    },
    {
      "n": 26,
      "t": "    mov ds, ax                ; 查 GDT，装载 DS 缓存"
    },
    {
      "n": 27,
      "t": "    mov ax, [ds:0x10]          ; 读物理 0x20010，AX = 7"
    },
    {
      "n": 28,
      "t": "    jmp 0x08:after_cs          ; 查 GDT[1]，重装 CS"
    }
  ],
  "interrupt": [
    {
      "n": 33,
      "t": "after_cs:"
    },
    {
      "n": 34,
      "t": "    lidt [cs:idt_ptr]          ; 读 6 字节，装入 IDTR"
    },
    {
      "n": 35,
      "t": "    int 0x21                  ; CPU 查 IDT[0x21]"
    },
    {
      "n": 36,
      "t": "resume:"
    },
    {
      "n": 37,
      "t": "    hlt                       ; 返回这里时 EBX = 1"
    },
    {
      "n": 38,
      "t": "    jmp resume"
    }
  ],
  "handler": [
    {
      "n": 43,
      "t": "handler:                      ; 地址 0x12340"
    },
    {
      "n": 44,
      "t": "    inc ebx                   ; EBX 从 0 变成 1"
    },
    {
      "n": 45,
      "t": "    iretd                     ; 弹出 EIP、CS、EFLAGS"
    }
  ],
  "data": [
    {
      "n": 50,
      "t": "value: dw 7                   ; 物理地址 0x20010"
    }
  ],
  "gdt": [
    {
      "n": 55,
      "t": "gdt:                          ; 地址 0x50000"
    },
    {
      "n": 56,
      "t": "    dq 0                      ; GDT[0]：空项"
    },
    {
      "n": 57,
      "t": "    dq 0x00CF9A000000FFFF     ; GDT[1]：代码段，基址 0"
    },
    {
      "n": 58,
      "t": "data_descriptor:              ; GDT[2]：地址 0x50010"
    },
    {
      "n": 59,
      "t": "    dw 0xFFFF, 0x0000         ; 段界限低 16 位、基址低 16 位"
    },
    {
      "n": 60,
      "t": "    db 0x02, 0x92             ; 基址中 8 位、权限"
    },
    {
      "n": 61,
      "t": "    db 0x40, 0x00             ; 标志、基址高 8 位"
    },
    {
      "n": 62,
      "t": "gdt_end:"
    }
  ],
  "gdt_ptr": [
    {
      "n": 67,
      "t": "gdt_ptr:                      ; 记录自身在 0x52000"
    },
    {
      "n": 68,
      "t": "    dw gdt_end - gdt - 1       ; 2 字节：limit = 0x17"
    },
    {
      "n": 69,
      "t": "    dd gdt                    ; 4 字节：base = 0x50000"
    }
  ],
  "idt_ptr": [
    {
      "n": 74,
      "t": "idt_ptr:                      ; 记录自身在 0x52010"
    },
    {
      "n": 75,
      "t": "    dw idt_end - idt - 1       ; limit = 0x7FF"
    },
    {
      "n": 76,
      "t": "    dd idt                    ; base = 0x60000"
    }
  ],
  "idt": [
    {
      "n": 81,
      "t": "idt:                          ; 地址 0x60000"
    },
    {
      "n": 82,
      "t": "    times 0x21 dq 0           ; 前 33 项留空"
    },
    {
      "n": 83,
      "t": "gate21:                       ; 第 33 项：0x60108"
    },
    {
      "n": 84,
      "t": "    dw HANDLER & 0xFFFF       ; 入口偏移低 16 位：0x2340"
    },
    {
      "n": 85,
      "t": "    dw 0x08                   ; 代码段选择子：GDT[1]"
    },
    {
      "n": 86,
      "t": "    db 0, 0x8E                ; 保留字节、32 位中断门属性"
    },
    {
      "n": 87,
      "t": "    dw HANDLER >> 16          ; 入口偏移高 16 位：0x0001"
    },
    {
      "n": 88,
      "t": "    times (256 - 0x22) dq 0   ; 剩余表项留空"
    },
    {
      "n": 89,
      "t": "idt_end:"
    }
  ]
};
