; 演示程序（不是开机代码）：16 位实模式，NASM 语法
; 放在物理地址 0x10000：CS = 0x1000，IP = 0
; 栈：SS = 0x3000，SP = 0x0100；数据：0x20010 处存着 7
        org  0
start:
        mov  ax, 0x2000      ; B8 00 20
        mov  ds, ax          ; 8E D8
        mov  ax, [0x0010]    ; A1 10 00
        add  ax, 5           ; 05 05 00
        mov  [0x0012], ax    ; A3 12 00
        push ax              ; 50
        call double          ; E8 04 00
        pop  bx              ; 5B
        hlt                  ; F4
        jmp  start           ; EB EA

double:
        add  ax, ax          ; 01 C0
        ret                  ; C3
