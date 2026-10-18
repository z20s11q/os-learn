// 由 scripts/build-boot-story.mjs 生成，请勿手改。
export const CODE = {
 "sb-reset": {
  "file": "seabios/src/romlayout.S",
  "lang": "汇编",
  "lines": [
   {
    "n": 687,
    "t": "        ORG 0xfff0 // Power-up Entry Point"
   },
   {
    "n": 688,
    "t": "        .global reset_vector"
   },
   {
    "n": 689,
    "t": "reset_vector:"
   },
   {
    "n": 690,
    "t": "        ljmpw $SEG_BIOS, $entry_post"
   }
  ]
 },
 "sb-entry": {
  "file": "seabios/src/romlayout.S",
  "lang": "汇编",
  "lines": [
   {
    "n": 594,
    "t": "entry_post:"
   },
   {
    "n": 595,
    "t": "        cmpl $0, %cs:HaveRunPost                // Check for resume/reboot"
   },
   {
    "n": 596,
    "t": "        jnz entry_resume"
   },
   {
    "n": 597,
    "t": "        ENTRY_INTO32 _cfunc32flat_handle_post   // Normal entry point"
   }
  ]
 },
 "sb-trans32": {
  "file": "seabios/src/romlayout.S",
  "lang": "汇编",
  "lines": [
   {
    "n": 26,
    "t": "transition32:"
   },
   {
    "n": 27,
    "t": "        // Disable irqs (and clear direction flag)"
   },
   {
    "n": 28,
    "t": "        cli"
   },
   {
    "n": 29,
    "t": "        cld"
   },
   {
    "n": 30,
    "t": ""
   },
   {
    "n": 31,
    "t": "        // Disable nmi"
   },
   {
    "n": 32,
    "t": "        movl %eax, %ecx"
   },
   {
    "n": 33,
    "t": "        movl $CMOS_RESET_CODE|NMI_DISABLE_BIT, %eax"
   },
   {
    "n": 34,
    "t": "        outb %al, $PORT_CMOS_INDEX"
   },
   {
    "n": 35,
    "t": "        inb $PORT_CMOS_DATA, %al"
   },
   {
    "n": 36,
    "t": ""
   },
   {
    "n": 37,
    "t": "        // enable a20"
   },
   {
    "n": 38,
    "t": "        inb $PORT_A20, %al"
   },
   {
    "n": 39,
    "t": "        orb $A20_ENABLE_BIT, %al"
   },
   {
    "n": 40,
    "t": "        outb %al, $PORT_A20"
   },
   {
    "n": 41,
    "t": "        movl %ecx, %eax"
   },
   {
    "n": 42,
    "t": ""
   },
   {
    "n": 43,
    "t": "transition32_nmi_off:"
   },
   {
    "n": 44,
    "t": "        // Set segment descriptors"
   },
   {
    "n": 45,
    "t": "        lidtw %cs:pmode_IDT_info"
   },
   {
    "n": 46,
    "t": "        lgdtw %cs:rombios32_gdt_48"
   },
   {
    "n": 47,
    "t": ""
   },
   {
    "n": 48,
    "t": "        // Enable protected mode"
   },
   {
    "n": 49,
    "t": "        movl %cr0, %ecx"
   },
   {
    "n": 50,
    "t": "        andl $~(CR0_PG|CR0_CD|CR0_NW), %ecx"
   },
   {
    "n": 51,
    "t": "        orl $CR0_PE, %ecx"
   },
   {
    "n": 52,
    "t": "        movl %ecx, %cr0"
   },
   {
    "n": 53,
    "t": ""
   },
   {
    "n": 54,
    "t": "        // start 32bit protected mode code"
   },
   {
    "n": 55,
    "t": "        ljmpl $SEG32_MODE32_CS, $(BUILD_BIOS_ADDR + 1f)"
   },
   {
    "n": 57,
    "t": "        .code32"
   },
   {
    "n": 58,
    "t": "        // init data segments"
   },
   {
    "n": 59,
    "t": "1:      movl $SEG32_MODE32_DS, %ecx"
   },
   {
    "n": 60,
    "t": "        movw %cx, %ds"
   },
   {
    "n": 61,
    "t": "        movw %cx, %es"
   },
   {
    "n": 62,
    "t": "        movw %cx, %ss"
   },
   {
    "n": 63,
    "t": "        movw %cx, %fs"
   },
   {
    "n": 64,
    "t": "        movw %cx, %gs"
   },
   {
    "n": 66,
    "t": "        jmpl *%edx"
   }
  ]
 },
 "sb-trans16": {
  "file": "seabios/src/romlayout.S",
  "lang": "汇编",
  "lines": [
   { "n": 75, "t": "transition16:" },
   { "n": 76, "t": "        // Reset data segment limits" },
   { "n": 77, "t": "        movl $SEG32_MODE16_DS, %ecx" },
   { "n": 78, "t": "        movw %cx, %ds" },
   { "n": 79, "t": "        movw %cx, %es" },
   { "n": 80, "t": "        movw %cx, %ss" },
   { "n": 81, "t": "        movw %cx, %fs" },
   { "n": 82, "t": "        movw %cx, %gs" },
   { "n": 85, "t": "        ljmpw $SEG32_MODE16_CS, $1f" },
   { "n": 87, "t": "transition16big:" },
   { "n": 88, "t": "        movl $SEG32_MODE16BIG_DS, %ecx" },
   { "n": 89, "t": "        movw %cx, %ds" },
   { "n": 90, "t": "        movw %cx, %es" },
   { "n": 91, "t": "        movw %cx, %ss" },
   { "n": 92, "t": "        movw %cx, %fs" },
   { "n": 93, "t": "        movw %cx, %gs" },
   { "n": 95, "t": "        ljmpw $SEG32_MODE16BIG_CS, $1f" },
   { "n": 97, "t": "        .code16" },
   { "n": 98, "t": "        // Disable protected mode" },
   { "n": 99, "t": "1:      movl %cr0, %ecx" },
   { "n": 100, "t": "        andl $~CR0_PE, %ecx" },
   { "n": 101, "t": "        movl %ecx, %cr0" },
   { "n": 103, "t": "        // far jump to flush CPU queue after transition to real mode" },
   { "n": 104, "t": "        ljmpw $SEG_BIOS, $2f" },
   { "n": 106, "t": "        // restore IDT to normal real-mode defaults" },
   { "n": 107, "t": "2:      lidtw %cs:rmode_IDT_info" },
   { "n": 110, "t": "        xorw %cx, %cx" },
   { "n": 111, "t": "        movw %cx, %fs" },
   { "n": 112, "t": "        movw %cx, %gs" },
   { "n": 113, "t": "        movw %cx, %es" },
   { "n": 114, "t": "        movw %cx, %ds" },
   { "n": 115, "t": "        movw %cx, %ss  // Assume stack is in segment 0" },
   { "n": 117, "t": "        jmpl *%edx" }
  ]
 },
 "sb-dopost": {
  "file": "seabios/src/post.c",
  "lang": "C",
  "lines": [
   {
    "n": 304,
    "t": "dopost(void)"
   },
   {
    "n": 305,
    "t": "{"
   },
   {
    "n": 306,
    "t": "    code_mutable_preinit();"
   },
   {
    "n": 307,
    "t": ""
   },
   {
    "n": 308,
    "t": "    // Detect ram and setup internal malloc."
   },
   {
    "n": 309,
    "t": "    qemu_preinit();"
   },
   {
    "n": 310,
    "t": "    coreboot_preinit();"
   },
   {
    "n": 311,
    "t": "    malloc_preinit();"
   },
   {
    "n": 312,
    "t": ""
   },
   {
    "n": 313,
    "t": "    // Relocate initialization code and call maininit()."
   },
   {
    "n": 314,
    "t": "    reloc_preinit(maininit, NULL);"
   }
  ]
 },
 "sb-iface": {
  "file": "seabios/src/post.c",
  "lang": "C",
  "lines": [
   {
    "n": 102,
    "t": "interface_init(void)"
   },
   {
    "n": 103,
    "t": "{"
   },
   {
    "n": 104,
    "t": "    // Running at new code address - do code relocation fixups"
   },
   {
    "n": 105,
    "t": "    malloc_init();"
   },
   {
    "n": 106,
    "t": ""
   },
   {
    "n": 107,
    "t": "    // Setup romfile items."
   },
   {
    "n": 108,
    "t": "    qemu_cfg_init();"
   },
   {
    "n": 109,
    "t": "    coreboot_cbfs_init();"
   },
   {
    "n": 110,
    "t": "    multiboot_init();"
   },
   {
    "n": 111,
    "t": ""
   },
   {
    "n": 112,
    "t": "    // Setup ivt/bda/ebda"
   },
   {
    "n": 113,
    "t": "    ivt_init();"
   },
   {
    "n": 114,
    "t": "    bda_init();"
   },
   {
    "n": 115,
    "t": ""
   },
   {
    "n": 116,
    "t": "    // Other interfaces"
   },
   {
    "n": 117,
    "t": "    boot_init();"
   },
   {
    "n": 118,
    "t": "    bios32_init();"
   },
   {
    "n": 119,
    "t": "    pmm_init();"
   },
   {
    "n": 120,
    "t": "    pnp_init();"
   },
   {
    "n": 121,
    "t": "    kbd_init();"
   },
   {
    "n": 122,
    "t": "    mouse_init();"
   }
  ]
 },
 "sb-ivt": {
  "file": "seabios/src/post.c",
  "lang": "C",
  "lines": [
   {
    "n": 33,
    "t": "ivt_init(void)"
   },
   {
    "n": 34,
    "t": "{"
   },
   {
    "n": 35,
    "t": "    dprintf(3, \"init ivt\\n\");"
   },
   {
    "n": 36,
    "t": ""
   },
   {
    "n": 37,
    "t": "    // Initialize all vectors to the default handler."
   },
   {
    "n": 38,
    "t": "    int i;"
   },
   {
    "n": 39,
    "t": "    for (i=0; i<256; i++)"
   },
   {
    "n": 40,
    "t": "        SET_IVT(i, FUNC16(entry_iret_official));"
   },
   {
    "n": 41,
    "t": ""
   },
   {
    "n": 42,
    "t": "    // Initialize all hw vectors to a default hw handler."
   },
   {
    "n": 43,
    "t": "    for (i=BIOS_HWIRQ0_VECTOR; i<BIOS_HWIRQ0_VECTOR+8; i++)"
   },
   {
    "n": 44,
    "t": "        SET_IVT(i, FUNC16(entry_hwpic1));"
   },
   {
    "n": 45,
    "t": "    for (i=BIOS_HWIRQ8_VECTOR; i<BIOS_HWIRQ8_VECTOR+8; i++)"
   },
   {
    "n": 46,
    "t": "        SET_IVT(i, FUNC16(entry_hwpic2));"
   },
   {
    "n": 47,
    "t": ""
   },
   {
    "n": 48,
    "t": "    // Initialize software handlers."
   },
   {
    "n": 49,
    "t": "    SET_IVT(0x02, FUNC16(entry_02));"
   },
   {
    "n": 50,
    "t": "    SET_IVT(0x05, FUNC16(entry_05));"
   },
   {
    "n": 51,
    "t": "    SET_IVT(0x10, FUNC16(entry_10));"
   },
   {
    "n": 52,
    "t": "    SET_IVT(0x11, FUNC16(entry_11));"
   },
   {
    "n": 53,
    "t": "    SET_IVT(0x12, FUNC16(entry_12));"
   },
   {
    "n": 54,
    "t": "    SET_IVT(0x13, FUNC16(entry_13_official));"
   },
   {
    "n": 55,
    "t": "    SET_IVT(0x14, FUNC16(entry_14));"
   },
   {
    "n": 56,
    "t": "    SET_IVT(0x15, FUNC16(entry_15_official));"
   },
   {
    "n": 57,
    "t": "    SET_IVT(0x16, FUNC16(entry_16));"
   },
   {
    "n": 58,
    "t": "    SET_IVT(0x17, FUNC16(entry_17));"
   },
   {
    "n": 59,
    "t": "    SET_IVT(0x18, FUNC16(entry_18));"
   },
   {
    "n": 60,
    "t": "    SET_IVT(0x19, FUNC16(entry_19_official));"
   },
   {
    "n": 61,
    "t": "    SET_IVT(0x1a, FUNC16(entry_1a_official));"
   },
   {
    "n": 62,
    "t": "    SET_IVT(0x40, FUNC16(entry_40));"
   }
  ]
 },
 "sb-main": {
  "file": "seabios/src/post.c",
  "lang": "C",
  "lines": [
   {
    "n": 197,
    "t": "maininit(void)"
   },
   {
    "n": 198,
    "t": "{"
   },
   {
    "n": 199,
    "t": "    // Initialize internal interfaces."
   },
   {
    "n": 200,
    "t": "    interface_init();"
   },
   {
    "n": 201,
    "t": ""
   },
   {
    "n": 202,
    "t": "    // Setup platform devices."
   },
   {
    "n": 203,
    "t": "    platform_hardware_setup();"
   },
   {
    "n": 204,
    "t": ""
   },
   {
    "n": 205,
    "t": "    // Start hardware initialization (if threads allowed during optionroms)"
   },
   {
    "n": 206,
    "t": "    if (threads_during_optionroms())"
   },
   {
    "n": 207,
    "t": "        device_hardware_setup();"
   },
   {
    "n": 208,
    "t": ""
   },
   {
    "n": 209,
    "t": "    // Run vga option rom"
   },
   {
    "n": 210,
    "t": "    vgarom_setup();"
   },
   {
    "n": 211,
    "t": "    sercon_setup();"
   },
   {
    "n": 212,
    "t": "    enable_vga_console();"
   },
   {
    "n": 213,
    "t": ""
   },
   {
    "n": 214,
    "t": "    // Do hardware initialization (if running synchronously)"
   },
   {
    "n": 215,
    "t": "    if (!threads_during_optionroms()) {"
   },
   {
    "n": 216,
    "t": "        device_hardware_setup();"
   },
   {
    "n": 217,
    "t": "        wait_threads();"
   },
   {
    "n": 218,
    "t": "    }"
   },
   {
    "n": 219,
    "t": ""
   },
   {
    "n": 220,
    "t": "    // Run option roms"
   },
   {
    "n": 221,
    "t": "    optionrom_setup();"
   },
   {
    "n": 222,
    "t": ""
   },
   {
    "n": 223,
    "t": "    // Allow user to modify overall boot order."
   },
   {
    "n": 224,
    "t": "    interactive_bootmenu();"
   },
   {
    "n": 225,
    "t": "    wait_threads();"
   },
   {
    "n": 226,
    "t": ""
   },
   {
    "n": 227,
    "t": "    // Prepare for boot."
   },
   {
    "n": 228,
    "t": "    prepareboot();"
   },
   {
    "n": 229,
    "t": ""
   },
   {
    "n": 230,
    "t": "    // Write protect bios memory."
   },
   {
    "n": 231,
    "t": "    make_bios_readonly();"
   },
   {
    "n": 232,
    "t": ""
   },
   {
    "n": 233,
    "t": "    // Invoke int 19 to start boot process."
   },
   {
    "n": 234,
    "t": "    startBoot();"
   }
  ]
 },
 "sb-cdrom": {
  "file": "seabios/src/boot.c",
  "lang": "C",
  "lines": [
   {
    "n": 918,
    "t": "boot_cdrom(struct drive_s *drive)"
   },
   {
    "n": 919,
    "t": "{"
   },
   {
    "n": 920,
    "t": "    if (! CONFIG_CDROM_BOOT)"
   },
   {
    "n": 921,
    "t": "        return;"
   },
   {
    "n": 922,
    "t": "    printf(\"Booting from DVD/CD...\\n\");"
   },
   {
    "n": 923,
    "t": ""
   },
   {
    "n": 924,
    "t": "    int status = cdrom_boot(drive);"
   },
   {
    "n": 925,
    "t": "    if (status) {"
   },
   {
    "n": 926,
    "t": "        printf(\"Boot failed: Could not read from CDROM (code %04x)\\n\", status);"
   },
   {
    "n": 927,
    "t": "        return;"
   },
   {
    "n": 928,
    "t": "    }"
   },
   {
    "n": 929,
    "t": ""
   },
   {
    "n": 930,
    "t": "    u8 bootdrv = CDEmu.emulated_drive;"
   },
   {
    "n": 931,
    "t": "    u16 bootseg = CDEmu.load_segment;"
   },
   {
    "n": 932,
    "t": ""
   },
   {
    "n": 933,
    "t": "    tpm_add_cdrom(bootdrv, MAKE_FLATPTR(bootseg, 0), 512);"
   },
   {
    "n": 934,
    "t": ""
   },
   {
    "n": 935,
    "t": "    /* Canonicalize bootseg:bootip */"
   },
   {
    "n": 936,
    "t": "    u16 bootip = (bootseg & 0x0fff) << 4;"
   },
   {
    "n": 937,
    "t": "    bootseg &= 0xf000;"
   },
   {
    "n": 938,
    "t": ""
   },
   {
    "n": 939,
    "t": "    call_boot_entry(SEGOFF(bootseg, bootip), bootdrv);"
   }
  ]
 },
 "sb-cdread": {
  "file": "seabios/src/cdrom.c",
  "lang": "C",
  "lines": [
   {
    "n": 147,
    "t": "// Read the Boot Record Volume Descriptor"
   },
   {
    "n": 148,
    "t": "u8 buffer[CDROM_SECTOR_SIZE];"
   },
   {
    "n": 149,
    "t": "dop.command = CMD_READ;"
   },
   {
    "n": 150,
    "t": "dop.lba = 0x11;"
   },
   {
    "n": 151,
    "t": "dop.count = 1;"
   },
   {
    "n": 152,
    "t": "dop.buf_fl = buffer;"
   },
   {
    "n": 153,
    "t": "ret = process_op(&dop);"
   },
   {
    "n": 154,
    "t": "if (ret)"
   },
   {
    "n": 155,
    "t": "    return 3;"
   },
   {
    "n": 156,
    "t": ""
   },
   {
    "n": 157,
    "t": "// Validity checks"
   },
   {
    "n": 158,
    "t": "if (buffer[0])"
   },
   {
    "n": 159,
    "t": "    return 4;"
   },
   {
    "n": 160,
    "t": "if (strcmp((char*)&buffer[1], \"CD001\\001EL TORITO SPECIFICATION\") != 0)"
   },
   {
    "n": 161,
    "t": "    return 5;"
   },
   {
    "n": 162,
    "t": ""
   },
   {
    "n": 163,
    "t": "// ok, now we calculate the Boot catalog address"
   },
   {
    "n": 164,
    "t": "u32 lba = *(u32*)&buffer[0x47];"
   },
   {
    "n": 165,
    "t": ""
   },
   {
    "n": 166,
    "t": "// And we read the Boot Catalog"
   },
   {
    "n": 167,
    "t": "dop.lba = lba;"
   },
   {
    "n": 168,
    "t": "dop.count = 1;"
   },
   {
    "n": 169,
    "t": "ret = process_op(&dop);"
   },
   {
    "n": 170,
    "t": "if (ret)"
   },
   {
    "n": 171,
    "t": "    return 7;"
   },
   {
    "n": 172,
    "t": ""
   },
   {
    "n": 173,
    "t": "// Validation entry"
   },
   {
    "n": 174,
    "t": "if (buffer[0x00] != 0x01)"
   },
   {
    "n": 175,
    "t": "    return 8;   // Header"
   },
   {
    "n": 176,
    "t": "if (buffer[0x01] != 0x00)"
   },
   {
    "n": 177,
    "t": "    return 9;   // Platform"
   },
   {
    "n": 178,
    "t": "if (buffer[0x1E] != 0x55)"
   },
   {
    "n": 179,
    "t": "    return 10;  // key 1"
   },
   {
    "n": 180,
    "t": "if (buffer[0x1F] != 0xAA)"
   },
   {
    "n": 181,
    "t": "    return 10;  // key 2"
   },
   {
    "n": 182,
    "t": ""
   },
   {
    "n": 183,
    "t": "// Initial/Default Entry"
   },
   {
    "n": 184,
    "t": "if (buffer[0x20] != 0x88)"
   },
   {
    "n": 185,
    "t": "    return 11; // Bootable"
   },
   {
    "n": 186,
    "t": ""
   },
   {
    "n": 187,
    "t": "/* measure 2048 bytes (one sector) */"
   },
   {
    "n": 188,
    "t": "tpm_add_cdrom_catalog(MAKE_FLATPTR(GET_SEG(SS), buffer), sizeof(buffer));"
   },
   {
    "n": 189,
    "t": ""
   },
   {
    "n": 190,
    "t": "// Fill in el-torito cdrom emulation fields."
   },
   {
    "n": 191,
    "t": "emulated_drive_gf = drive;"
   },
   {
    "n": 192,
    "t": "u8 media = buffer[0x21];"
   },
   {
    "n": 193,
    "t": ""
   },
   {
    "n": 194,
    "t": "u16 boot_segment = *(u16*)&buffer[0x22];"
   },
   {
    "n": 195,
    "t": "if (!boot_segment)"
   },
   {
    "n": 196,
    "t": "    boot_segment = 0x07C0;"
   },
   {
    "n": 197,
    "t": "CDEmu.load_segment = boot_segment;"
   },
   {
    "n": 198,
    "t": "CDEmu.buffer_segment = 0x0000;"
   },
   {
    "n": 199,
    "t": ""
   },
   {
    "n": 200,
    "t": "u16 nbsectors = *(u16*)&buffer[0x26];"
   },
   {
    "n": 201,
    "t": "CDEmu.sector_count = nbsectors;"
   },
   {
    "n": 202,
    "t": ""
   },
   {
    "n": 203,
    "t": "lba = *(u32*)&buffer[0x28];"
   },
   {
    "n": 204,
    "t": "CDEmu.ilba = lba;"
   },
   {
    "n": 205,
    "t": ""
   },
   {
    "n": 206,
    "t": "CDEmu.controller_index = drive->cntl_id / 2;"
   },
   {
    "n": 207,
    "t": "CDEmu.device_spec = drive->cntl_id % 2;"
   },
   {
    "n": 208,
    "t": ""
   },
   {
    "n": 209,
    "t": "// And we read the image in memory"
   },
   {
    "n": 210,
    "t": "nbsectors = DIV_ROUND_UP(nbsectors, 4);"
   },
   {
    "n": 211,
    "t": "dop.lba = lba;"
   },
   {
    "n": 212,
    "t": "dop.buf_fl = MAKE_FLATPTR(boot_segment, 0);"
   }
  ]
 },
 "sb-callboot": {
  "file": "seabios/src/boot.c",
  "lang": "C",
  "lines": [
   {
    "n": 864,
    "t": "call_boot_entry(struct segoff_s bootsegip, u8 bootdrv)"
   },
   {
    "n": 865,
    "t": "{"
   },
   {
    "n": 866,
    "t": "    dprintf(1, \"Booting from %04x:%04x\\n\", bootsegip.seg, bootsegip.offset);"
   },
   {
    "n": 867,
    "t": "    struct bregs br;"
   },
   {
    "n": 868,
    "t": "    memset(&br, 0, sizeof(br));"
   },
   {
    "n": 869,
    "t": "    br.flags = F_IF;"
   },
   {
    "n": 870,
    "t": "    br.code = bootsegip;"
   },
   {
    "n": 871,
    "t": "    // Set the magic number in ax and the boot drive in dl."
   },
   {
    "n": 872,
    "t": "    br.dl = bootdrv;"
   },
   {
    "n": 873,
    "t": "    br.ax = 0xaa55;"
   },
   {
    "n": 874,
    "t": "    farcall16(&br);"
   }
  ]
 },
 "grub-cfg": {
  "file": "labs/linux-x86_64/grub.cfg",
  "lang": "配置",
  "lines": [
   {
    "n": 1,
    "t": "set timeout=0"
   },
   {
    "n": 2,
    "t": "set default=0"
   },
   {
    "n": 3,
    "t": "terminal_output console"
   },
   {
    "n": 4,
    "t": "menuentry 'Linux 6.12.112 Observatory' {"
   },
   {
    "n": 5,
    "t": "  linux16 /boot/bzImage nokaslr norandmaps pti=off console=tty0 console=ttyS0,115200 rdinit=/init loglevel=5"
   },
   {
    "n": 6,
    "t": "  initrd16 /boot/initramfs.cpio.gz"
   }
  ]
 },
 "lx-header": {
  "file": "linux/arch/x86/boot/header.S",
  "lang": "汇编",
  "lines": [
   {
    "n": 538,
    "t": "start_of_setup:"
   },
   {
    "n": 539,
    "t": "# Force %es = %ds"
   },
   {
    "n": 540,
    "t": "        movw    %ds, %ax"
   },
   {
    "n": 541,
    "t": "        movw    %ax, %es"
   },
   {
    "n": 542,
    "t": "        cld"
   },
   {
    "n": 543,
    "t": ""
   },
   {
    "n": 544,
    "t": "# Apparently some ancient versions of LILO invoked the kernel with %ss != %ds,"
   },
   {
    "n": 545,
    "t": "# which happened to work by accident for the old code.  Recalculate the stack"
   },
   {
    "n": 546,
    "t": "# pointer if %ss is invalid.  Otherwise leave it alone, LOADLIN sets up the"
   },
   {
    "n": 547,
    "t": "# stack behind its own code, so we can't blindly put it directly past the heap."
   },
   {
    "n": 548,
    "t": ""
   },
   {
    "n": 549,
    "t": "        movw    %ss, %dx"
   },
   {
    "n": 550,
    "t": "        cmpw    %ax, %dx        # %ds == %ss?"
   },
   {
    "n": 551,
    "t": "        movw    %sp, %dx"
   },
   {
    "n": 552,
    "t": "        je      2f              # -> assume %sp is reasonably set"
   },
   {
    "n": 553,
    "t": ""
   },
   {
    "n": 554,
    "t": "        # Invalid %ss, make up a new stack"
   },
   {
    "n": 555,
    "t": "        movw    $_end, %dx"
   },
   {
    "n": 556,
    "t": "        testb   $CAN_USE_HEAP, loadflags"
   },
   {
    "n": 557,
    "t": "        jz      1f"
   },
   {
    "n": 558,
    "t": "        movw    heap_end_ptr, %dx"
   },
   {
    "n": 559,
    "t": "1:      addw    $STACK_SIZE, %dx"
   },
   {
    "n": 560,
    "t": "        jnc     2f"
   },
   {
    "n": 561,
    "t": "        xorw    %dx, %dx        # Prevent wraparound"
   },
   {
    "n": 562,
    "t": ""
   },
   {
    "n": 563,
    "t": "2:      # Now %dx should point to the end of our stack space"
   },
   {
    "n": 564,
    "t": "        andw    $~3, %dx        # dword align (might as well...)"
   },
   {
    "n": 565,
    "t": "        jnz     3f"
   },
   {
    "n": 566,
    "t": "        movw    $0xfffc, %dx    # Make sure we're not zero"
   },
   {
    "n": 567,
    "t": "3:      movw    %ax, %ss"
   },
   {
    "n": 568,
    "t": "        movzwl  %dx, %esp       # Clear upper half of %esp"
   },
   {
    "n": 569,
    "t": "        sti                     # Now we should have a working stack"
   },
   {
    "n": 570,
    "t": ""
   },
   {
    "n": 571,
    "t": "# We will have entered with %cs = %ds+0x20, normalize %cs so"
   },
   {
    "n": 572,
    "t": "# it is on par with the other segments."
   },
   {
    "n": 573,
    "t": "        pushw   %ds"
   },
   {
    "n": 574,
    "t": "        pushw   $6f"
   },
   {
    "n": 575,
    "t": "        lretw"
   },
   {
    "n": 576,
    "t": "6:"
   },
   {
    "n": 577,
    "t": ""
   },
   {
    "n": 578,
    "t": "# Check signature at end of setup"
   },
   {
    "n": 579,
    "t": "        cmpl    $0x5a5aaa55, setup_sig"
   },
   {
    "n": 580,
    "t": "        jne     setup_bad"
   },
   {
    "n": 581,
    "t": ""
   },
   {
    "n": 582,
    "t": "# Zero the bss"
   },
   {
    "n": 583,
    "t": "        movw    $__bss_start, %di"
   },
   {
    "n": 584,
    "t": "        movw    $_end+3, %cx"
   },
   {
    "n": 585,
    "t": "        xorl    %eax, %eax"
   },
   {
    "n": 586,
    "t": "        subw    %di, %cx"
   },
   {
    "n": 587,
    "t": "        shrw    $2, %cx"
   },
   {
    "n": 588,
    "t": "        rep; stosl"
   },
   {
    "n": 589,
    "t": ""
   },
   {
    "n": 590,
    "t": "# Jump to C code (should not return)"
   },
   {
    "n": 591,
    "t": "        calll   main"
   }
  ]
 },
 "lx-main": {
  "file": "linux/arch/x86/boot/main.c",
  "lang": "C",
  "lines": [
   {
    "n": 133,
    "t": "void main(void)"
   },
   {
    "n": 134,
    "t": "{"
   },
   {
    "n": 135,
    "t": "        init_default_io_ops();"
   },
   {
    "n": 136,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 138,
    "t": "        copy_boot_params();"
   },
   {
    "n": 139,
    "t": ""
   },
   {
    "n": 140,
    "t": "        /* Initialize the early-boot console */"
   },
   {
    "n": 141,
    "t": "        console_init();"
   },
   {
    "n": 142,
    "t": "        if (cmdline_find_option_bool(\"debug\"))"
   },
   {
    "n": 143,
    "t": "                puts(\"early console in setup code\\n\");"
   },
   {
    "n": 144,
    "t": ""
   },
   {
    "n": 145,
    "t": "        /* End of heap check */"
   },
   {
    "n": 146,
    "t": "        init_heap();"
   },
   {
    "n": 147,
    "t": ""
   },
   {
    "n": 148,
    "t": "        /* Make sure we have all the proper CPU support */"
   },
   {
    "n": 149,
    "t": "        if (validate_cpu()) {"
   },
   {
    "n": 150,
    "t": "                puts(\"Unable to boot - please use a kernel appropriate for your CPU.\\n\");"
   },
   {
    "n": 151,
    "t": "                die();"
   },
   {
    "n": 152,
    "t": "        }"
   },
   {
    "n": 153,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 155,
    "t": "        set_bios_mode();"
   },
   {
    "n": 156,
    "t": ""
   },
   {
    "n": 157,
    "t": "        /* Detect memory layout */"
   },
   {
    "n": 158,
    "t": "        detect_memory();"
   },
   {
    "n": 159,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 161,
    "t": "        keyboard_init();"
   },
   {
    "n": 162,
    "t": ""
   },
   {
    "n": 163,
    "t": "        /* Query Intel SpeedStep (IST) information */"
   },
   {
    "n": 164,
    "t": "        query_ist();"
   },
   {
    "n": 165,
    "t": ""
   },
   {
    "n": 166,
    "t": "        /* Query APM information */"
   },
   {
    "gap": true
   },
   {
    "n": 171,
    "t": "        /* Query EDD information */"
   },
   {
    "gap": true
   },
   {
    "n": 176,
    "t": "        /* Set the video mode */"
   },
   {
    "n": 177,
    "t": "        set_video();"
   },
   {
    "n": 178,
    "t": ""
   },
   {
    "n": 179,
    "t": "        /* Do the last things and invoke protected mode */"
   },
   {
    "n": 180,
    "t": "        go_to_protected_mode();"
   }
  ]
 },
 "lx-e820": {
  "file": "linux/arch/x86/boot/memory.c",
  "lang": "C",
  "lines": [
   {
    "n": 18,
    "t": "static void detect_memory_e820(void)"
   },
   {
    "n": 19,
    "t": "{"
   },
   {
    "n": 20,
    "t": "        int count = 0;"
   },
   {
    "n": 21,
    "t": "        struct biosregs ireg, oreg;"
   },
   {
    "n": 22,
    "t": "        struct boot_e820_entry *desc = boot_params.e820_table;"
   },
   {
    "n": 23,
    "t": "        static struct boot_e820_entry buf; /* static so it is zeroed */"
   },
   {
    "n": 24,
    "t": ""
   },
   {
    "n": 25,
    "t": "        initregs(&ireg);"
   },
   {
    "n": 26,
    "t": "        ireg.ax  = 0xe820;"
   },
   {
    "n": 27,
    "t": "        ireg.cx  = sizeof(buf);"
   },
   {
    "n": 28,
    "t": "        ireg.edx = SMAP;"
   },
   {
    "n": 29,
    "t": "        ireg.di  = (size_t)&buf;"
   },
   {
    "n": 30,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 45,
    "t": "        do {"
   },
   {
    "n": 46,
    "t": "                intcall(0x15, &ireg, &oreg);"
   }
  ]
 },
 "lx-gopm": {
  "file": "linux/arch/x86/boot/pm.c",
  "lang": "C",
  "lines": [
   {
    "n": 103,
    "t": "void go_to_protected_mode(void)"
   },
   {
    "n": 104,
    "t": "{"
   },
   {
    "gap": true
   },
   {
    "n": 106,
    "t": "        realmode_switch_hook();"
   },
   {
    "n": 107,
    "t": ""
   },
   {
    "n": 108,
    "t": "        /* Enable the A20 gate */"
   },
   {
    "n": 109,
    "t": "        if (enable_a20()) {"
   },
   {
    "n": 110,
    "t": "                puts(\"A20 gate not responding, unable to boot...\\n\");"
   },
   {
    "n": 111,
    "t": "                die();"
   },
   {
    "n": 112,
    "t": "        }"
   },
   {
    "n": 113,
    "t": ""
   },
   {
    "n": 114,
    "t": "        /* Reset coprocessor (IGNNE#) */"
   },
   {
    "n": 115,
    "t": "        reset_coprocessor();"
   },
   {
    "n": 116,
    "t": ""
   },
   {
    "n": 117,
    "t": "        /* Mask all interrupts in the PIC */"
   },
   {
    "n": 118,
    "t": "        mask_all_interrupts();"
   },
   {
    "n": 119,
    "t": ""
   },
   {
    "n": 120,
    "t": "        /* Actual transition to protected mode... */"
   },
   {
    "n": 121,
    "t": "        setup_idt();"
   },
   {
    "n": 122,
    "t": "        setup_gdt();"
   },
   {
    "n": 123,
    "t": "        protected_mode_jump(boot_params.hdr.code32_start,"
   },
   {
    "n": 124,
    "t": "                            (u32)&boot_params + (ds() << 4));"
   }
  ]
 },
 "lx-gdt": {
  "file": "linux/arch/x86/boot/pm.c",
  "lang": "C",
  "lines": [
   {
    "n": 65,
    "t": "static void setup_gdt(void)"
   },
   {
    "n": 66,
    "t": "{"
   },
   {
    "gap": true
   },
   {
    "n": 69,
    "t": "        static const u64 boot_gdt[] __attribute__((aligned(16))) = {"
   },
   {
    "n": 70,
    "t": "                /* CS: code, read/execute, 4 GB, base 0 */"
   },
   {
    "n": 71,
    "t": "                [GDT_ENTRY_BOOT_CS] = GDT_ENTRY(DESC_CODE32, 0, 0xfffff),"
   },
   {
    "n": 72,
    "t": "                /* DS: data, read/write, 4 GB, base 0 */"
   },
   {
    "n": 73,
    "t": "                [GDT_ENTRY_BOOT_DS] = GDT_ENTRY(DESC_DATA32, 0, 0xfffff),"
   },
   {
    "n": 74,
    "t": "                /* TSS: 32-bit tss, 104 bytes, base 4096 */"
   },
   {
    "gap": true
   },
   {
    "n": 77,
    "t": "                [GDT_ENTRY_BOOT_TSS] = GDT_ENTRY(DESC_TSS32, 4096, 103),"
   },
   {
    "n": 78,
    "t": "        };"
   },
   {
    "gap": true
   },
   {
    "n": 83,
    "t": "        static struct gdt_ptr gdt;"
   },
   {
    "n": 84,
    "t": ""
   },
   {
    "n": 85,
    "t": "        gdt.len = sizeof(boot_gdt)-1;"
   },
   {
    "n": 86,
    "t": "        gdt.ptr = (u32)&boot_gdt + (ds() << 4);"
   },
   {
    "n": 87,
    "t": ""
   },
   {
    "n": 88,
    "t": "        asm volatile(\"lgdtl %0\" : : \"m\" (gdt));"
   }
  ]
 },
 "lx-pmjump": {
  "file": "linux/arch/x86/boot/pmjump.S",
  "lang": "汇编",
  "lines": [
   {
    "n": 24,
    "t": "SYM_FUNC_START_NOALIGN(protected_mode_jump)"
   },
   {
    "n": 25,
    "t": "        movl    %edx, %esi              # Pointer to boot_params table"
   },
   {
    "n": 26,
    "t": ""
   },
   {
    "n": 27,
    "t": "        xorl    %ebx, %ebx"
   },
   {
    "n": 28,
    "t": "        movw    %cs, %bx"
   },
   {
    "n": 29,
    "t": "        shll    $4, %ebx"
   },
   {
    "n": 30,
    "t": "        addl    %ebx, 2f"
   },
   {
    "n": 31,
    "t": "        jmp     1f                      # Short jump to serialize on 386/486"
   },
   {
    "n": 32,
    "t": "1:"
   },
   {
    "n": 33,
    "t": ""
   },
   {
    "n": 34,
    "t": "        movw    $__BOOT_DS, %cx"
   },
   {
    "n": 35,
    "t": "        movw    $__BOOT_TSS, %di"
   },
   {
    "n": 36,
    "t": ""
   },
   {
    "n": 37,
    "t": "        movl    %cr0, %edx"
   },
   {
    "n": 38,
    "t": "        orb     $X86_CR0_PE, %dl        # Protected mode"
   },
   {
    "n": 39,
    "t": "        movl    %edx, %cr0"
   },
   {
    "n": 40,
    "t": ""
   },
   {
    "n": 41,
    "t": "        # Transition to 32-bit mode"
   },
   {
    "n": 42,
    "t": "        .byte   0x66, 0xea              # ljmpl opcode"
   },
   {
    "n": 43,
    "t": "2:      .long   .Lin_pm32               # offset"
   },
   {
    "n": 44,
    "t": "        .word   __BOOT_CS               # segment"
   },
   {
    "n": 45,
    "t": "SYM_FUNC_END(protected_mode_jump)"
   },
   {
    "n": 46,
    "t": ""
   },
   {
    "n": 47,
    "t": "        .code32"
   },
   {
    "n": 48,
    "t": "        .section \".text32\",\"ax\""
   },
   {
    "n": 49,
    "t": "SYM_FUNC_START_LOCAL_NOALIGN(.Lin_pm32)"
   },
   {
    "n": 50,
    "t": "        # Set up data segments for flat 32-bit mode"
   },
   {
    "n": 51,
    "t": "        movl    %ecx, %ds"
   },
   {
    "n": 52,
    "t": "        movl    %ecx, %es"
   },
   {
    "n": 53,
    "t": "        movl    %ecx, %fs"
   },
   {
    "n": 54,
    "t": "        movl    %ecx, %gs"
   },
   {
    "n": 55,
    "t": "        movl    %ecx, %ss"
   },
   {
    "n": 56,
    "t": "        # The 32-bit code sets up its own stack, but this way we do have"
   },
   {
    "n": 57,
    "t": "        # a valid stack if some debugging hack wants to use it."
   },
   {
    "n": 58,
    "t": "        addl    %ebx, %esp"
   },
   {
    "n": 59,
    "t": ""
   },
   {
    "n": 60,
    "t": "        # Set up TR to make Intel VT happy"
   },
   {
    "n": 61,
    "t": "        ltr     %di"
   },
   {
    "n": 62,
    "t": ""
   },
   {
    "n": 63,
    "t": "        # Clear registers to allow for future extensions to the"
   },
   {
    "n": 64,
    "t": "        # 32-bit boot protocol"
   },
   {
    "n": 65,
    "t": "        xorl    %ecx, %ecx"
   },
   {
    "n": 66,
    "t": "        xorl    %edx, %edx"
   },
   {
    "n": 67,
    "t": "        xorl    %ebx, %ebx"
   },
   {
    "n": 68,
    "t": "        xorl    %ebp, %ebp"
   },
   {
    "n": 69,
    "t": "        xorl    %edi, %edi"
   },
   {
    "n": 70,
    "t": ""
   },
   {
    "n": 71,
    "t": "        # Set up LDTR to make Intel VT happy"
   },
   {
    "n": 72,
    "t": "        lldt    %cx"
   },
   {
    "n": 73,
    "t": ""
   },
   {
    "n": 74,
    "t": "        jmpl    *%eax                   # Jump to the 32-bit entrypoint"
   },
   {
    "n": 75,
    "t": "SYM_FUNC_END(.Lin_pm32)"
   }
  ]
 },
 "lx-startup32": {
  "file": "linux/arch/x86/boot/compressed/head_64.S",
  "lang": "汇编",
  "lines": [
   {
    "n": 83,
    "t": "SYM_FUNC_START(startup_32)"
   },
   {
    "gap": true
   },
   {
    "n": 90,
    "t": "        cld"
   },
   {
    "n": 91,
    "t": "        cli"
   },
   {
    "n": 92,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 101,
    "t": "        leal    (BP_scratch+4)(%esi), %esp"
   },
   {
    "n": 102,
    "t": "        call    1f"
   },
   {
    "n": 103,
    "t": "1:      popl    %ebp"
   },
   {
    "n": 104,
    "t": "        subl    $ rva(1b), %ebp"
   },
   {
    "n": 105,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 107,
    "t": "        leal    rva(gdt)(%ebp), %eax"
   },
   {
    "n": 108,
    "t": "        movl    %eax, 2(%eax)"
   },
   {
    "n": 109,
    "t": "        lgdt    (%eax)"
   },
   {
    "n": 110,
    "t": ""
   },
   {
    "n": 111,
    "t": "        /* Load segment registers with our descriptors */"
   },
   {
    "n": 112,
    "t": "        movl    $__BOOT_DS, %eax"
   },
   {
    "n": 113,
    "t": "        movl    %eax, %ds"
   },
   {
    "n": 114,
    "t": "        movl    %eax, %es"
   },
   {
    "n": 115,
    "t": "        movl    %eax, %fs"
   },
   {
    "n": 116,
    "t": "        movl    %eax, %gs"
   },
   {
    "n": 117,
    "t": "        movl    %eax, %ss"
   },
   {
    "n": 118,
    "t": ""
   },
   {
    "n": 119,
    "t": "        /* Setup a stack and load CS from current GDT */"
   },
   {
    "n": 120,
    "t": "        leal    rva(boot_stack_end)(%ebp), %esp"
   },
   {
    "n": 121,
    "t": ""
   },
   {
    "n": 122,
    "t": "        pushl   $__KERNEL32_CS"
   },
   {
    "n": 123,
    "t": "        leal    rva(1f)(%ebp), %eax"
   },
   {
    "n": 124,
    "t": "        pushl   %eax"
   },
   {
    "n": 125,
    "t": "        lretl"
   },
   {
    "n": 126,
    "t": "1:"
   },
   {
    "n": 127,
    "t": ""
   },
   {
    "n": 128,
    "t": "        /* Setup Exception handling for SEV-ES */"
   },
   {
    "gap": true
   },
   {
    "n": 133,
    "t": "        /* Make sure cpu supports long mode. */"
   },
   {
    "n": 134,
    "t": "        call    verify_cpu"
   },
   {
    "n": 135,
    "t": "        testl   %eax, %eax"
   },
   {
    "n": 136,
    "t": "        jnz     .Lno_longmode"
   },
   {
    "n": 137,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 148,
    "t": "        movl    %ebp, %ebx"
   },
   {
    "n": 149,
    "t": "        movl    BP_kernel_alignment(%esi), %eax"
   },
   {
    "n": 150,
    "t": "        decl    %eax"
   },
   {
    "n": 151,
    "t": "        addl    %eax, %ebx"
   },
   {
    "n": 152,
    "t": "        notl    %eax"
   },
   {
    "n": 153,
    "t": "        andl    %eax, %ebx"
   },
   {
    "n": 154,
    "t": "        cmpl    $LOAD_PHYSICAL_ADDR, %ebx"
   },
   {
    "n": 155,
    "t": "        jae     1f"
   },
   {
    "n": 157,
    "t": "        movl    $LOAD_PHYSICAL_ADDR, %ebx"
   },
   {
    "n": 158,
    "t": "1:"
   },
   {
    "n": 159,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 161,
    "t": "        addl    BP_init_size(%esi), %ebx"
   },
   {
    "n": 162,
    "t": "        subl    $ rva(_end), %ebx"
   },
   {
    "n": 163,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 168,
    "t": "        /* Enable PAE mode */"
   },
   {
    "n": 169,
    "t": "        movl    %cr4, %eax"
   },
   {
    "n": 170,
    "t": "        orl     $X86_CR4_PAE, %eax"
   },
   {
    "n": 171,
    "t": "        movl    %eax, %cr4"
   },
   {
    "n": 172,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 181,
    "t": "        xorl    %edx, %edx"
   },
   {
    "gap": true
   },
   {
    "n": 200,
    "t": "        /* Initialize Page tables to 0 */"
   },
   {
    "n": 201,
    "t": "        leal    rva(pgtable)(%ebx), %edi"
   },
   {
    "n": 202,
    "t": "        xorl    %eax, %eax"
   },
   {
    "n": 203,
    "t": "        movl    $(BOOT_INIT_PGT_SIZE/4), %ecx"
   },
   {
    "n": 204,
    "t": "        rep     stosl"
   },
   {
    "n": 205,
    "t": ""
   },
   {
    "n": 206,
    "t": "        /* Build Level 4 */"
   },
   {
    "n": 207,
    "t": "        leal    rva(pgtable + 0)(%ebx), %edi"
   },
   {
    "n": 208,
    "t": "        leal    0x1007 (%edi), %eax"
   },
   {
    "n": 209,
    "t": "        movl    %eax, 0(%edi)"
   },
   {
    "n": 210,
    "t": "        addl    %edx, 4(%edi)"
   },
   {
    "n": 211,
    "t": ""
   },
   {
    "n": 212,
    "t": "        /* Build Level 3 */"
   },
   {
    "n": 213,
    "t": "        leal    rva(pgtable + 0x1000)(%ebx), %edi"
   },
   {
    "n": 214,
    "t": "        leal    0x1007(%edi), %eax"
   },
   {
    "n": 215,
    "t": "        movl    $4, %ecx"
   },
   {
    "n": 216,
    "t": "1:      movl    %eax, 0x00(%edi)"
   },
   {
    "n": 217,
    "t": "        addl    %edx, 0x04(%edi)"
   },
   {
    "n": 218,
    "t": "        addl    $0x00001000, %eax"
   },
   {
    "n": 219,
    "t": "        addl    $8, %edi"
   },
   {
    "n": 220,
    "t": "        decl    %ecx"
   },
   {
    "n": 221,
    "t": "        jnz     1b"
   },
   {
    "n": 222,
    "t": ""
   },
   {
    "n": 223,
    "t": "        /* Build Level 2 */"
   },
   {
    "n": 224,
    "t": "        leal    rva(pgtable + 0x2000)(%ebx), %edi"
   },
   {
    "n": 225,
    "t": "        movl    $0x00000183, %eax"
   },
   {
    "n": 226,
    "t": "        movl    $2048, %ecx"
   },
   {
    "n": 227,
    "t": "1:      movl    %eax, 0(%edi)"
   },
   {
    "n": 228,
    "t": "        addl    %edx, 4(%edi)"
   },
   {
    "n": 229,
    "t": "        addl    $0x00200000, %eax"
   },
   {
    "n": 230,
    "t": "        addl    $8, %edi"
   },
   {
    "n": 231,
    "t": "        decl    %ecx"
   },
   {
    "n": 232,
    "t": "        jnz     1b"
   },
   {
    "n": 233,
    "t": ""
   },
   {
    "n": 234,
    "t": "        /* Enable the boot page tables */"
   },
   {
    "n": 235,
    "t": "        leal    rva(pgtable)(%ebx), %eax"
   },
   {
    "n": 236,
    "t": "        movl    %eax, %cr3"
   },
   {
    "n": 237,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 239,
    "t": "        movl    $MSR_EFER, %ecx"
   },
   {
    "n": 240,
    "t": "        rdmsr"
   },
   {
    "n": 241,
    "t": "        btsl    $_EFER_LME, %eax"
   },
   {
    "n": 242,
    "t": "        wrmsr"
   },
   {
    "n": 243,
    "t": ""
   },
   {
    "n": 244,
    "t": "        /* After gdt is loaded */"
   },
   {
    "n": 245,
    "t": "        xorl    %eax, %eax"
   },
   {
    "n": 246,
    "t": "        lldt    %ax"
   },
   {
    "n": 247,
    "t": "        movl    $__BOOT_TSS, %eax"
   },
   {
    "n": 248,
    "t": "        ltr     %ax"
   },
   {
    "n": 249,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 265,
    "t": "        leal    rva(startup_64)(%ebp), %eax"
   },
   {
    "n": 267,
    "t": "        cmpb    $1, rva(efi_is64)(%ebp)"
   },
   {
    "n": 268,
    "t": "        je      1f"
   },
   {
    "n": 269,
    "t": "        leal    rva(startup_64_mixed_mode)(%ebp), %eax"
   },
   {
    "n": 270,
    "t": "1:"
   },
   {
    "n": 272,
    "t": ""
   },
   {
    "n": 273,
    "t": "        pushl   $__KERNEL_CS"
   },
   {
    "n": 274,
    "t": "        pushl   %eax"
   },
   {
    "n": 275,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 277,
    "t": "        movl    $CR0_STATE, %eax"
   },
   {
    "n": 278,
    "t": "        movl    %eax, %cr0"
   },
   {
    "n": 279,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 281,
    "t": "        lret"
   },
   {
    "n": 282,
    "t": "SYM_FUNC_END(startup_32)"
   }
  ]
 },
 "lx-startup64z": {
  "file": "linux/arch/x86/boot/compressed/head_64.S",
  "lang": "汇编",
  "lines": [
   {
    "n": 286,
    "t": "SYM_CODE_START(startup_64)"
   },
   {
    "gap": true
   },
   {
    "n": 298,
    "t": "        cld"
   },
   {
    "n": 299,
    "t": "        cli"
   },
   {
    "n": 300,
    "t": ""
   },
   {
    "n": 301,
    "t": "        /* Setup data segments. */"
   },
   {
    "n": 302,
    "t": "        xorl    %eax, %eax"
   },
   {
    "n": 303,
    "t": "        movl    %eax, %ds"
   },
   {
    "n": 304,
    "t": "        movl    %eax, %es"
   },
   {
    "n": 305,
    "t": "        movl    %eax, %ss"
   },
   {
    "n": 306,
    "t": "        movl    %eax, %fs"
   },
   {
    "n": 307,
    "t": "        movl    %eax, %gs"
   },
   {
    "n": 308,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 324,
    "t": "        leaq    startup_32(%rip) /* - $startup_32 */, %rbp"
   },
   {
    "n": 325,
    "t": "        movl    BP_kernel_alignment(%rsi), %eax"
   },
   {
    "n": 326,
    "t": "        decl    %eax"
   },
   {
    "n": 327,
    "t": "        addq    %rax, %rbp"
   },
   {
    "n": 328,
    "t": "        notq    %rax"
   },
   {
    "n": 329,
    "t": "        andq    %rax, %rbp"
   },
   {
    "n": 330,
    "t": "        cmpq    $LOAD_PHYSICAL_ADDR, %rbp"
   },
   {
    "n": 331,
    "t": "        jae     1f"
   },
   {
    "n": 333,
    "t": "        movq    $LOAD_PHYSICAL_ADDR, %rbp"
   },
   {
    "n": 334,
    "t": "1:"
   },
   {
    "n": 335,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 337,
    "t": "        movl    BP_init_size(%rsi), %ebx"
   },
   {
    "n": 338,
    "t": "        subl    $ rva(_end), %ebx"
   },
   {
    "n": 339,
    "t": "        addq    %rbp, %rbx"
   },
   {
    "n": 340,
    "t": ""
   },
   {
    "n": 341,
    "t": "        /* Set up the stack */"
   },
   {
    "n": 342,
    "t": "        leaq    rva(boot_stack_end)(%rbx), %rsp"
   },
   {
    "n": 343,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 366,
    "t": "        leaq    gdt64(%rip), %rax"
   },
   {
    "n": 367,
    "t": "        addq    %rax, 2(%rax)"
   },
   {
    "n": 368,
    "t": "        lgdt    (%rax)"
   },
   {
    "n": 369,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 371,
    "t": "        pushq   $__KERNEL_CS"
   },
   {
    "n": 372,
    "t": "        leaq    .Lon_kernel_cs(%rip), %rax"
   },
   {
    "n": 373,
    "t": "        pushq   %rax"
   },
   {
    "n": 374,
    "t": "        lretq"
   },
   {
    "n": 375,
    "t": ""
   },
   {
    "n": 376,
    "t": ".Lon_kernel_cs:"
   },
   {
    "gap": true
   },
   {
    "n": 382,
    "t": "        movq    %rsi, %r15"
   },
   {
    "n": 383,
    "t": ""
   },
   {
    "n": 384,
    "t": "        call    load_stage1_idt"
   },
   {
    "n": 385,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 402,
    "t": "        movq    %cr4, %rax"
   },
   {
    "n": 403,
    "t": "        andl    $(X86_CR4_PAE | X86_CR4_MCE | X86_CR4_LA57), %eax"
   },
   {
    "n": 404,
    "t": "        movq    %rax, %cr4"
   },
   {
    "n": 405,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 415,
    "t": "        movq    %r15, %rdi"
   },
   {
    "n": 416,
    "t": "        leaq    rva(top_pgtable)(%rbx), %rsi"
   },
   {
    "n": 417,
    "t": "        call    configure_5level_paging"
   },
   {
    "n": 418,
    "t": ""
   },
   {
    "n": 419,
    "t": "        /* Zero EFLAGS */"
   },
   {
    "n": 420,
    "t": "        pushq   $0"
   },
   {
    "n": 421,
    "t": "        popfq"
   },
   {
    "n": 422,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 427,
    "t": "        leaq    (_bss-8)(%rip), %rsi"
   },
   {
    "n": 428,
    "t": "        leaq    rva(_bss-8)(%rbx), %rdi"
   },
   {
    "n": 429,
    "t": "        movl    $(_bss - startup_32), %ecx"
   },
   {
    "n": 430,
    "t": "        shrl    $3, %ecx"
   },
   {
    "n": 431,
    "t": "        std"
   },
   {
    "n": 432,
    "t": "        rep     movsq"
   },
   {
    "n": 433,
    "t": "        cld"
   },
   {
    "n": 434,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 440,
    "t": "        leaq    rva(gdt64)(%rbx), %rax"
   },
   {
    "n": 441,
    "t": "        leaq    rva(gdt)(%rbx), %rdx"
   },
   {
    "n": 442,
    "t": "        movq    %rdx, 2(%rax)"
   },
   {
    "n": 443,
    "t": "        lgdt    (%rax)"
   },
   {
    "n": 444,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 448,
    "t": "        leaq    rva(.Lrelocated)(%rbx), %rax"
   },
   {
    "n": 449,
    "t": "        jmp     *%rax"
   },
   {
    "n": 450,
    "t": "SYM_CODE_END(startup_64)"
   },
   {
    "n": 451,
    "t": ""
   },
   {
    "n": 452,
    "t": "        .text"
   },
   {
    "n": 453,
    "t": "SYM_FUNC_START_LOCAL_NOALIGN(.Lrelocated)"
   },
   {
    "n": 454,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 458,
    "t": "        xorl    %eax, %eax"
   },
   {
    "n": 459,
    "t": "        leaq    _bss(%rip), %rdi"
   },
   {
    "n": 460,
    "t": "        leaq    _ebss(%rip), %rcx"
   },
   {
    "n": 461,
    "t": "        subq    %rdi, %rcx"
   },
   {
    "n": 462,
    "t": "        shrq    $3, %rcx"
   },
   {
    "n": 463,
    "t": "        rep     stosq"
   },
   {
    "n": 464,
    "t": ""
   },
   {
    "n": 465,
    "t": "        call    load_stage2_idt"
   },
   {
    "n": 466,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 468,
    "t": "        movq    %r15, %rdi"
   },
   {
    "n": 469,
    "t": "        call    initialize_identity_maps"
   },
   {
    "n": 470,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 475,
    "t": "        movq    %r15, %rdi"
   },
   {
    "n": 476,
    "t": "        movq    %rbp, %rsi"
   },
   {
    "n": 477,
    "t": "        call    extract_kernel          /* returns kernel entry point in %rax */"
   },
   {
    "n": 478,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 482,
    "t": "        movq    %r15, %rsi"
   },
   {
    "n": 483,
    "t": "        jmp     *%rax"
   },
   {
    "n": 484,
    "t": "SYM_FUNC_END(.Lrelocated)"
   }
  ]
 },
 "lx-extract": {
  "file": "linux/arch/x86/boot/compressed/misc.c",
  "lang": "C",
  "lines": [
   {
    "n": 510,
    "t": "debug_putstr(\"\\nDecompressing Linux... \");"
   },
   {
    "n": 511,
    "t": ""
   },
   {
    "n": 512,
    "t": "if (init_unaccepted_memory()) {"
   },
   {
    "n": 513,
    "t": "        debug_putstr(\"Accepting memory... \");"
   },
   {
    "n": 514,
    "t": "        accept_memory(__pa(output), needed_size);"
   },
   {
    "n": 515,
    "t": "}"
   },
   {
    "n": 516,
    "t": ""
   },
   {
    "n": 517,
    "t": "entry_offset = decompress_kernel(output, virt_addr, error);"
   },
   {
    "n": 518,
    "t": ""
   },
   {
    "n": 519,
    "t": "debug_putstr(\"done.\\nBooting the kernel (entry_offset: 0x\");"
   },
   {
    "n": 520,
    "t": "debug_puthex(entry_offset);"
   },
   {
    "n": 521,
    "t": "debug_putstr(\").\\n\");"
   },
   {
    "n": 522,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 524,
    "t": "cleanup_exception_handling();"
   },
   {
    "n": 525,
    "t": ""
   },
   {
    "n": 526,
    "t": "if (spurious_nmi_count) {"
   },
   {
    "n": 527,
    "t": "        error_putstr(\"Spurious early NMIs ignored: \");"
   },
   {
    "n": 528,
    "t": "        error_putdec(spurious_nmi_count);"
   },
   {
    "n": 529,
    "t": "        error_putstr(\"\\n\");"
   },
   {
    "n": 530,
    "t": "}"
   },
   {
    "n": 531,
    "t": ""
   },
   {
    "n": 532,
    "t": "return output + entry_offset;"
   }
  ]
 },
 "lx-head64": {
  "file": "linux/arch/x86/kernel/head_64.S",
  "lang": "汇编",
  "lines": [
   {
    "n": 38,
    "t": "SYM_CODE_START_NOALIGN(startup_64)"
   },
   {
    "n": 39,
    "t": "        UNWIND_HINT_END_OF_STACK"
   },
   {
    "gap": true
   },
   {
    "n": 59,
    "t": "        mov     %rsi, %r15"
   },
   {
    "n": 60,
    "t": ""
   },
   {
    "n": 61,
    "t": "        /* Set up the stack for verify_cpu() */"
   },
   {
    "n": 62,
    "t": "        leaq    __top_init_kernel_stack(%rip), %rsp"
   },
   {
    "n": 63,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 65,
    "t": "        movl    $MSR_GS_BASE, %ecx"
   },
   {
    "n": 66,
    "t": "        leaq    INIT_PER_CPU_VAR(fixed_percpu_data)(%rip), %rdx"
   },
   {
    "n": 67,
    "t": "        movl    %edx, %eax"
   },
   {
    "n": 68,
    "t": "        shrq    $32,  %rdx"
   },
   {
    "n": 69,
    "t": "        wrmsr"
   },
   {
    "n": 70,
    "t": ""
   },
   {
    "n": 71,
    "t": "        call    startup_64_setup_gdt_idt"
   },
   {
    "n": 72,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 74,
    "t": "        pushq   $__KERNEL_CS"
   },
   {
    "n": 75,
    "t": "        leaq    .Lon_kernel_cs(%rip), %rax"
   },
   {
    "n": 76,
    "t": "        pushq   %rax"
   },
   {
    "n": 77,
    "t": "        lretq"
   },
   {
    "n": 78,
    "t": ""
   },
   {
    "n": 79,
    "t": ".Lon_kernel_cs:"
   },
   {
    "n": 80,
    "t": "        UNWIND_HINT_END_OF_STACK"
   },
   {
    "n": 81,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 93,
    "t": "        /* Sanitize CPU configuration */"
   },
   {
    "n": 94,
    "t": "        call verify_cpu"
   },
   {
    "n": 95,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 102,
    "t": "        leaq    _text(%rip), %rdi"
   },
   {
    "n": 103,
    "t": "        movq    %r15, %rsi"
   },
   {
    "n": 104,
    "t": "        call    __startup_64"
   },
   {
    "n": 105,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 107,
    "t": "        leaq    early_top_pgt(%rip), %rcx"
   },
   {
    "n": 108,
    "t": "        addq    %rcx, %rax"
   },
   {
    "n": 109,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 126,
    "t": "        movq    %rax, %cr3"
   },
   {
    "n": 127,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 129,
    "t": "        ANNOTATE_RETPOLINE_SAFE"
   },
   {
    "n": 130,
    "t": "        jmp     *0f(%rip)"
   },
   {
    "n": 131,
    "t": "SYM_CODE_END(startup_64)"
   }
  ]
 },
 "lx-common64": {
  "file": "linux/arch/x86/kernel/head_64.S",
  "lang": "汇编",
  "lines": [
   {
    "n": 188,
    "t": "SYM_INNER_LABEL(common_startup_64, SYM_L_LOCAL)"
   },
   {
    "n": 189,
    "t": "        UNWIND_HINT_END_OF_STACK"
   },
   {
    "n": 190,
    "t": "        ANNOTATE_NOENDBR"
   },
   {
    "n": 191,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 201,
    "t": "        movl    $(X86_CR4_PAE | X86_CR4_LA57), %edx"
   },
   {
    "gap": true
   },
   {
    "n": 210,
    "t": "        orl     $X86_CR4_MCE, %edx"
   },
   {
    "n": 212,
    "t": "        movq    %cr4, %rcx"
   },
   {
    "n": 213,
    "t": "        andl    %edx, %ecx"
   },
   {
    "n": 214,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 216,
    "t": "        btsl    $X86_CR4_PSE_BIT, %ecx"
   },
   {
    "n": 217,
    "t": "        movq    %rcx, %cr4"
   },
   {
    "n": 218,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 222,
    "t": "        btsl    $X86_CR4_PGE_BIT, %ecx"
   },
   {
    "n": 223,
    "t": "        movq    %rcx, %cr4"
   },
   {
    "n": 224,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 234,
    "t": "        movl    smpboot_control(%rip), %ecx"
   },
   {
    "n": 235,
    "t": "        testl   $STARTUP_READ_APICID, %ecx"
   },
   {
    "n": 236,
    "t": "        jnz     .Lread_apicid"
   },
   {
    "gap": true
   },
   {
    "n": 241,
    "t": "        andl    $(~STARTUP_PARALLEL_MASK), %ecx"
   },
   {
    "n": 242,
    "t": "        jmp     .Lsetup_cpu"
   },
   {
    "n": 243,
    "t": ""
   },
   {
    "n": 244,
    "t": ".Lread_apicid:"
   },
   {
    "n": 245,
    "t": "        /* Check whether X2APIC mode is already enabled */"
   },
   {
    "n": 246,
    "t": "        mov     $MSR_IA32_APICBASE, %ecx"
   },
   {
    "n": 247,
    "t": "        rdmsr"
   },
   {
    "n": 248,
    "t": "        testl   $X2APIC_ENABLE, %eax"
   },
   {
    "n": 249,
    "t": "        jnz     .Lread_apicid_msr"
   },
   {
    "n": 250,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 266,
    "t": ".Lread_apicid_mmio:"
   },
   {
    "gap": true
   },
   {
    "n": 268,
    "t": "        movq    apic_mmio_base(%rip), %rcx"
   },
   {
    "n": 269,
    "t": "        addq    $APIC_ID, %rcx"
   },
   {
    "n": 270,
    "t": "        movl    (%rcx), %eax"
   },
   {
    "n": 271,
    "t": "        shr     $24, %eax"
   },
   {
    "n": 272,
    "t": "        jmp     .Llookup_AP"
   },
   {
    "n": 273,
    "t": ""
   },
   {
    "n": 274,
    "t": ".Lread_apicid_msr:"
   },
   {
    "n": 275,
    "t": "        mov     $APIC_X2APIC_ID_MSR, %ecx"
   },
   {
    "n": 276,
    "t": "        rdmsr"
   },
   {
    "n": 277,
    "t": ""
   },
   {
    "n": 278,
    "t": ".Llookup_AP:"
   },
   {
    "n": 279,
    "t": "        /* EAX contains the APIC ID of the current CPU */"
   },
   {
    "n": 280,
    "t": "        xorl    %ecx, %ecx"
   },
   {
    "n": 281,
    "t": "        leaq    cpuid_to_apicid(%rip), %rbx"
   },
   {
    "n": 282,
    "t": ""
   },
   {
    "n": 283,
    "t": ".Lfind_cpunr:"
   },
   {
    "n": 284,
    "t": "        cmpl    (%rbx,%rcx,4), %eax"
   },
   {
    "n": 285,
    "t": "        jz      .Lsetup_cpu"
   },
   {
    "n": 286,
    "t": "        inc     %ecx"
   },
   {
    "gap": true
   },
   {
    "n": 290,
    "t": "        cmpl    nr_cpu_ids(%rip), %ecx"
   },
   {
    "n": 292,
    "t": "        jb      .Lfind_cpunr"
   },
   {
    "n": 293,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 295,
    "t": "        movq    trampoline_lock(%rip), %rax"
   },
   {
    "n": 296,
    "t": "        movl    $0, (%rax)"
   },
   {
    "n": 297,
    "t": ""
   },
   {
    "n": 298,
    "t": "1:      cli"
   },
   {
    "n": 299,
    "t": "        hlt"
   },
   {
    "n": 300,
    "t": "        jmp     1b"
   },
   {
    "n": 301,
    "t": ""
   },
   {
    "n": 302,
    "t": ".Lsetup_cpu:"
   },
   {
    "gap": true
   },
   {
    "n": 304,
    "t": "        movq    __per_cpu_offset(,%rcx,8), %rdx"
   },
   {
    "gap": true
   },
   {
    "n": 315,
    "t": "        movq    pcpu_hot + X86_current_task(%rdx), %rax"
   },
   {
    "n": 316,
    "t": "        movq    TASK_threadsp(%rax), %rsp"
   },
   {
    "n": 317,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 322,
    "t": "        movq    trampoline_lock(%rip), %rax"
   },
   {
    "n": 323,
    "t": "        testq   %rax, %rax"
   },
   {
    "n": 324,
    "t": "        jz      .Lsetup_gdt"
   },
   {
    "n": 325,
    "t": "        movl    $0, (%rax)"
   },
   {
    "n": 326,
    "t": ""
   },
   {
    "n": 327,
    "t": ".Lsetup_gdt:"
   },
   {
    "gap": true
   },
   {
    "n": 334,
    "t": "        subq    $16, %rsp"
   },
   {
    "n": 335,
    "t": "        movw    $(GDT_SIZE-1), (%rsp)"
   },
   {
    "n": 336,
    "t": "        leaq    gdt_page(%rdx), %rax"
   },
   {
    "n": 337,
    "t": "        movq    %rax, 2(%rsp)"
   },
   {
    "n": 338,
    "t": "        lgdt    (%rsp)"
   },
   {
    "n": 339,
    "t": "        addq    $16, %rsp"
   },
   {
    "n": 340,
    "t": ""
   },
   {
    "n": 341,
    "t": "        /* set up data segments */"
   },
   {
    "n": 342,
    "t": "        xorl %eax,%eax"
   },
   {
    "n": 343,
    "t": "        movl %eax,%ds"
   },
   {
    "n": 344,
    "t": "        movl %eax,%ss"
   },
   {
    "n": 345,
    "t": "        movl %eax,%es"
   },
   {
    "n": 346,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 352,
    "t": "        movl %eax,%fs"
   },
   {
    "n": 353,
    "t": "        movl %eax,%gs"
   },
   {
    "n": 354,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 362,
    "t": "        movl    $MSR_GS_BASE,%ecx"
   },
   {
    "gap": true
   },
   {
    "n": 366,
    "t": "        movl    %edx, %eax"
   },
   {
    "n": 367,
    "t": "        shrq    $32, %rdx"
   },
   {
    "n": 368,
    "t": "        wrmsr"
   },
   {
    "n": 369,
    "t": ""
   },
   {
    "n": 370,
    "t": "        /* Setup and Load IDT */"
   },
   {
    "n": 371,
    "t": "        call    early_setup_idt"
   },
   {
    "n": 372,
    "t": ""
   },
   {
    "n": 373,
    "t": "        /* Check if nx is implemented */"
   },
   {
    "n": 374,
    "t": "        movl    $0x80000001, %eax"
   },
   {
    "n": 375,
    "t": "        cpuid"
   },
   {
    "n": 376,
    "t": "        movl    %edx,%edi"
   },
   {
    "n": 377,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 379,
    "t": "        movl    $MSR_EFER, %ecx"
   },
   {
    "n": 380,
    "t": "        rdmsr"
   },
   {
    "gap": true
   },
   {
    "n": 385,
    "t": "        movl    %eax, %edx"
   },
   {
    "n": 386,
    "t": "        btsl    $_EFER_SCE, %eax        /* Enable System Call */"
   },
   {
    "n": 387,
    "t": "        btl     $20,%edi                /* No Execute supported? */"
   },
   {
    "n": 388,
    "t": "        jnc     1f"
   },
   {
    "n": 389,
    "t": "        btsl    $_EFER_NX, %eax"
   },
   {
    "n": 390,
    "t": "        btsq    $_PAGE_BIT_NX,early_pmd_flags(%rip)"
   },
   {
    "n": 391,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 393,
    "t": "1:      cmpl    %edx, %eax"
   },
   {
    "n": 394,
    "t": "        je      1f"
   },
   {
    "n": 395,
    "t": "        xor     %edx, %edx"
   },
   {
    "n": 396,
    "t": "        wrmsr                           /* Make changes effective */"
   },
   {
    "n": 397,
    "t": "1:"
   },
   {
    "n": 398,
    "t": "        /* Setup cr0 */"
   },
   {
    "n": 399,
    "t": "        movl    $CR0_STATE, %eax"
   },
   {
    "n": 400,
    "t": "        /* Make changes effective */"
   },
   {
    "n": 401,
    "t": "        movq    %rax, %cr0"
   },
   {
    "n": 402,
    "t": ""
   },
   {
    "n": 403,
    "t": "        /* zero EFLAGS after setting rsp */"
   },
   {
    "n": 404,
    "t": "        pushq $0"
   },
   {
    "n": 405,
    "t": "        popfq"
   },
   {
    "n": 406,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 408,
    "t": "        movq    %r15, %rdi"
   },
   {
    "n": 409,
    "t": ""
   },
   {
    "n": 410,
    "t": ".Ljump_to_C_code:"
   },
   {
    "n": 411,
    "t": "        xorl    %ebp, %ebp      # clear frame pointer"
   },
   {
    "n": 412,
    "t": "        ANNOTATE_RETPOLINE_SAFE"
   },
   {
    "n": 413,
    "t": "        callq   *initial_code(%rip)"
   },
   {
    "n": 414,
    "t": "        ud2"
   },
   {
    "n": 415,
    "t": "SYM_CODE_END(secondary_startup_64)"
   }
  ]
 },
 "lx-head64c": {
  "file": "linux/arch/x86/kernel/head64.c",
  "lang": "C",
  "lines": [
   {
    "n": 441,
    "t": "cr4_init_shadow();"
   },
   {
    "n": 442,
    "t": ""
   },
   {
    "n": 443,
    "t": "/* Kill off the identity-map trampoline */"
   },
   {
    "n": 444,
    "t": "reset_early_page_tables();"
   },
   {
    "n": 445,
    "t": ""
   },
   {
    "n": 446,
    "t": "clear_bss();"
   },
   {
    "n": 447,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 452,
    "t": "clear_page(init_top_pgt);"
   },
   {
    "n": 453,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 459,
    "t": "sme_early_init();"
   },
   {
    "n": 460,
    "t": ""
   },
   {
    "n": 461,
    "t": "kasan_early_init();"
   },
   {
    "n": 462,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 471,
    "t": "__native_tlb_flush_global(this_cpu_read(cpu_tlbstate.cr4));"
   },
   {
    "n": 472,
    "t": ""
   },
   {
    "n": 473,
    "t": "idt_setup_early_handler();"
   },
   {
    "n": 474,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 476,
    "t": "tdx_early_init();"
   },
   {
    "n": 477,
    "t": ""
   },
   {
    "n": 478,
    "t": "copy_bootdata(__va(real_mode_data));"
   }
  ]
 },
 "lx-startk": {
  "file": "linux/init/main.c",
  "lang": "C",
  "lines": [
   {
    "n": 874,
    "t": "void start_kernel(void)"
   },
   {
    "n": 875,
    "t": "{"
   },
   {
    "n": 876,
    "t": "        char *command_line;"
   },
   {
    "n": 877,
    "t": "        char *after_dashes;"
   },
   {
    "n": 878,
    "t": ""
   },
   {
    "n": 879,
    "t": "        set_task_stack_end_magic(&init_task);"
   },
   {
    "n": 880,
    "t": "        smp_setup_processor_id();"
   },
   {
    "n": 881,
    "t": "        debug_objects_early_init();"
   },
   {
    "n": 882,
    "t": "        init_vmlinux_build_id();"
   },
   {
    "n": 883,
    "t": ""
   },
   {
    "n": 884,
    "t": "        cgroup_init_early();"
   },
   {
    "n": 885,
    "t": ""
   },
   {
    "n": 886,
    "t": "        local_irq_disable();"
   },
   {
    "n": 887,
    "t": "        early_boot_irqs_disabled = true;"
   },
   {
    "n": 888,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 893,
    "t": "        boot_cpu_init();"
   },
   {
    "n": 894,
    "t": "        page_address_init();"
   },
   {
    "n": 895,
    "t": "        pr_notice(\"%s\", linux_banner);"
   },
   {
    "n": 896,
    "t": "        setup_arch(&command_line);"
   },
   {
    "gap": true
   },
   {
    "n": 898,
    "t": "        jump_label_init();"
   },
   {
    "n": 899,
    "t": "        static_call_init();"
   },
   {
    "n": 900,
    "t": "        early_security_init();"
   },
   {
    "n": 901,
    "t": "        setup_boot_config();"
   },
   {
    "n": 902,
    "t": "        setup_command_line(command_line);"
   },
   {
    "n": 903,
    "t": "        setup_nr_cpu_ids();"
   },
   {
    "n": 904,
    "t": "        setup_per_cpu_areas();"
   },
   {
    "n": 905,
    "t": "        smp_prepare_boot_cpu(); /* arch-specific boot-cpu hooks */"
   },
   {
    "n": 906,
    "t": "        early_numa_node_init();"
   },
   {
    "n": 907,
    "t": "        boot_cpu_hotplug_init();"
   },
   {
    "n": 908,
    "t": ""
   },
   {
    "n": 909,
    "t": "        pr_notice(\"Kernel command line: %s\\n\", saved_command_line);"
   },
   {
    "n": 910,
    "t": "        /* parameters may set static keys */"
   },
   {
    "n": 911,
    "t": "        parse_early_param();"
   },
   {
    "n": 912,
    "t": "        after_dashes = parse_args(\"Booting kernel\","
   },
   {
    "n": 913,
    "t": "                                  static_command_line, __start___param,"
   },
   {
    "n": 914,
    "t": "                                  __stop___param - __start___param,"
   },
   {
    "n": 915,
    "t": "                                  -1, -1, NULL, &unknown_bootoption);"
   },
   {
    "n": 916,
    "t": "        print_unknown_bootoptions();"
   },
   {
    "n": 917,
    "t": "        if (!IS_ERR_OR_NULL(after_dashes))"
   },
   {
    "n": 918,
    "t": "                parse_args(\"Setting init args\", after_dashes, NULL, 0, -1, -1,"
   },
   {
    "n": 919,
    "t": "                           NULL, set_init_arg);"
   },
   {
    "n": 920,
    "t": "        if (extra_init_args)"
   },
   {
    "n": 921,
    "t": "                parse_args(\"Setting extra init args\", extra_init_args,"
   },
   {
    "n": 922,
    "t": "                           NULL, 0, -1, -1, NULL, set_init_arg);"
   },
   {
    "n": 923,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 925,
    "t": "        random_init_early(command_line);"
   },
   {
    "n": 926,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 931,
    "t": "        setup_log_buf(0);"
   },
   {
    "n": 932,
    "t": "        vfs_caches_init_early();"
   },
   {
    "n": 933,
    "t": "        sort_main_extable();"
   },
   {
    "n": 934,
    "t": "        trap_init();"
   },
   {
    "n": 935,
    "t": "        mm_core_init();"
   },
   {
    "n": 936,
    "t": "        poking_init();"
   },
   {
    "n": 937,
    "t": "        ftrace_init();"
   },
   {
    "n": 938,
    "t": ""
   },
   {
    "n": 939,
    "t": "        /* trace_printk can be enabled here */"
   },
   {
    "n": 940,
    "t": "        early_trace_init();"
   },
   {
    "n": 941,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 947,
    "t": "        sched_init();"
   },
   {
    "n": 948,
    "t": ""
   },
   {
    "n": 949,
    "t": "        if (WARN(!irqs_disabled(),"
   },
   {
    "n": 950,
    "t": "                 \"Interrupts were enabled *very* early, fixing it\\n\"))"
   },
   {
    "n": 951,
    "t": "                local_irq_disable();"
   },
   {
    "n": 952,
    "t": "        radix_tree_init();"
   },
   {
    "n": 953,
    "t": "        maple_tree_init();"
   },
   {
    "n": 954,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 959,
    "t": "        housekeeping_init();"
   },
   {
    "n": 960,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 966,
    "t": "        workqueue_init_early();"
   },
   {
    "n": 967,
    "t": ""
   },
   {
    "n": 968,
    "t": "        rcu_init();"
   },
   {
    "n": 969,
    "t": ""
   },
   {
    "n": 970,
    "t": "        /* Trace events are available after this */"
   },
   {
    "n": 971,
    "t": "        trace_init();"
   },
   {
    "n": 972,
    "t": ""
   },
   {
    "n": 973,
    "t": "        if (initcall_debug)"
   },
   {
    "n": 974,
    "t": "                initcall_debug_enable();"
   },
   {
    "n": 975,
    "t": ""
   },
   {
    "n": 976,
    "t": "        context_tracking_init();"
   },
   {
    "n": 977,
    "t": "        /* init some links before init_ISA_irqs() */"
   },
   {
    "n": 978,
    "t": "        early_irq_init();"
   },
   {
    "n": 979,
    "t": "        init_IRQ();"
   },
   {
    "n": 980,
    "t": "        tick_init();"
   },
   {
    "n": 981,
    "t": "        rcu_init_nohz();"
   },
   {
    "n": 982,
    "t": "        init_timers();"
   },
   {
    "n": 983,
    "t": "        srcu_init();"
   },
   {
    "n": 984,
    "t": "        hrtimers_init();"
   },
   {
    "n": 985,
    "t": "        softirq_init();"
   },
   {
    "n": 986,
    "t": "        timekeeping_init();"
   },
   {
    "n": 987,
    "t": "        time_init();"
   },
   {
    "n": 988,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 990,
    "t": "        random_init();"
   },
   {
    "n": 991,
    "t": ""
   },
   {
    "n": 992,
    "t": "        /* These make use of the fully initialized rng */"
   },
   {
    "n": 993,
    "t": "        kfence_init();"
   },
   {
    "n": 994,
    "t": "        boot_init_stack_canary();"
   },
   {
    "n": 995,
    "t": ""
   },
   {
    "n": 996,
    "t": "        perf_event_init();"
   },
   {
    "n": 997,
    "t": "        profile_init();"
   },
   {
    "n": 998,
    "t": "        call_function_init();"
   },
   {
    "n": 999,
    "t": "        WARN(!irqs_disabled(), \"Interrupts were enabled early\\n\");"
   },
   {
    "n": 1000,
    "t": ""
   },
   {
    "n": 1001,
    "t": "        early_boot_irqs_disabled = false;"
   },
   {
    "n": 1002,
    "t": "        local_irq_enable();"
   },
   {
    "n": 1003,
    "t": ""
   },
   {
    "n": 1004,
    "t": "        kmem_cache_init_late();"
   },
   {
    "n": 1005,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 1011,
    "t": "        console_init();"
   },
   {
    "n": 1012,
    "t": "        if (panic_later)"
   },
   {
    "n": 1013,
    "t": "                panic(\"Too many boot %s vars at `%s'\", panic_later,"
   },
   {
    "n": 1014,
    "t": "                      panic_param);"
   },
   {
    "n": 1015,
    "t": ""
   },
   {
    "n": 1016,
    "t": "        lockdep_init();"
   },
   {
    "n": 1017,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 1023,
    "t": "        locking_selftest();"
   },
   {
    "n": 1024,
    "t": ""
   },
   {
    "n": 1026,
    "t": "        if (initrd_start && !initrd_below_start_ok &&"
   },
   {
    "n": 1027,
    "t": "            page_to_pfn(virt_to_page((void *)initrd_start)) < min_low_pfn) {"
   },
   {
    "n": 1028,
    "t": "                pr_crit(\"initrd overwritten (0x%08lx < 0x%08lx) - disabling it.\\n\","
   },
   {
    "n": 1029,
    "t": "                    page_to_pfn(virt_to_page((void *)initrd_start)),"
   },
   {
    "n": 1030,
    "t": "                    min_low_pfn);"
   },
   {
    "n": 1031,
    "t": "                initrd_start = 0;"
   },
   {
    "n": 1032,
    "t": "        }"
   },
   {
    "n": 1034,
    "t": "        setup_per_cpu_pageset();"
   },
   {
    "n": 1035,
    "t": "        numa_policy_init();"
   },
   {
    "n": 1036,
    "t": "        acpi_early_init();"
   },
   {
    "n": 1037,
    "t": "        if (late_time_init)"
   },
   {
    "n": 1038,
    "t": "                late_time_init();"
   },
   {
    "n": 1039,
    "t": "        sched_clock_init();"
   },
   {
    "n": 1040,
    "t": "        calibrate_delay();"
   },
   {
    "n": 1041,
    "t": ""
   },
   {
    "n": 1042,
    "t": "        arch_cpu_finalize_init();"
   },
   {
    "n": 1043,
    "t": ""
   },
   {
    "n": 1044,
    "t": "        pid_idr_init();"
   },
   {
    "n": 1045,
    "t": "        anon_vma_init();"
   },
   {
    "n": 1047,
    "t": "        if (efi_enabled(EFI_RUNTIME_SERVICES))"
   },
   {
    "n": 1048,
    "t": "                efi_enter_virtual_mode();"
   },
   {
    "n": 1050,
    "t": "        thread_stack_cache_init();"
   },
   {
    "n": 1051,
    "t": "        cred_init();"
   },
   {
    "n": 1052,
    "t": "        fork_init();"
   },
   {
    "n": 1053,
    "t": "        proc_caches_init();"
   },
   {
    "n": 1054,
    "t": "        uts_ns_init();"
   },
   {
    "n": 1055,
    "t": "        key_init();"
   },
   {
    "n": 1056,
    "t": "        security_init();"
   },
   {
    "n": 1057,
    "t": "        dbg_late_init();"
   },
   {
    "n": 1058,
    "t": "        net_ns_init();"
   },
   {
    "n": 1059,
    "t": "        vfs_caches_init();"
   },
   {
    "n": 1060,
    "t": "        pagecache_init();"
   },
   {
    "n": 1061,
    "t": "        signals_init();"
   },
   {
    "n": 1062,
    "t": "        seq_file_init();"
   },
   {
    "n": 1063,
    "t": "        proc_root_init();"
   },
   {
    "n": 1064,
    "t": "        nsfs_init();"
   },
   {
    "n": 1065,
    "t": "        pidfs_init();"
   },
   {
    "n": 1066,
    "t": "        cpuset_init();"
   },
   {
    "n": 1067,
    "t": "        cgroup_init();"
   },
   {
    "n": 1068,
    "t": "        taskstats_init_early();"
   },
   {
    "n": 1069,
    "t": "        delayacct_init();"
   },
   {
    "n": 1070,
    "t": ""
   },
   {
    "n": 1071,
    "t": "        acpi_subsystem_init();"
   },
   {
    "n": 1072,
    "t": "        arch_post_acpi_subsys_init();"
   },
   {
    "n": 1073,
    "t": "        kcsan_init();"
   },
   {
    "n": 1074,
    "t": ""
   },
   {
    "n": 1075,
    "t": "        /* Do the rest non-__init'ed, we're now alive */"
   },
   {
    "n": 1076,
    "t": "        rest_init();"
   }
  ]
 },
 "lx-rest": {
  "file": "linux/init/main.c",
  "lang": "C",
  "lines": [
   {
    "n": 673,
    "t": "static noinline void __ref __noreturn rest_init(void)"
   },
   {
    "n": 674,
    "t": "{"
   },
   {
    "n": 675,
    "t": "        struct task_struct *tsk;"
   },
   {
    "n": 676,
    "t": "        int pid;"
   },
   {
    "n": 677,
    "t": ""
   },
   {
    "n": 678,
    "t": "        rcu_scheduler_starting();"
   },
   {
    "gap": true
   },
   {
    "n": 684,
    "t": "        pid = user_mode_thread(kernel_init, NULL, CLONE_FS);"
   },
   {
    "gap": true
   },
   {
    "n": 690,
    "t": "        rcu_read_lock();"
   },
   {
    "n": 691,
    "t": "        tsk = find_task_by_pid_ns(pid, &init_pid_ns);"
   },
   {
    "n": 692,
    "t": "        tsk->flags |= PF_NO_SETAFFINITY;"
   },
   {
    "n": 693,
    "t": "        set_cpus_allowed_ptr(tsk, cpumask_of(smp_processor_id()));"
   },
   {
    "n": 694,
    "t": "        rcu_read_unlock();"
   },
   {
    "n": 695,
    "t": ""
   },
   {
    "n": 696,
    "t": "        numa_default_policy();"
   },
   {
    "n": 697,
    "t": "        pid = kernel_thread(kthreadd, NULL, NULL, CLONE_FS | CLONE_FILES);"
   },
   {
    "n": 698,
    "t": "        rcu_read_lock();"
   },
   {
    "n": 699,
    "t": "        kthreadd_task = find_task_by_pid_ns(pid, &init_pid_ns);"
   },
   {
    "n": 700,
    "t": "        rcu_read_unlock();"
   },
   {
    "n": 701,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 709,
    "t": "        system_state = SYSTEM_SCHEDULING;"
   },
   {
    "n": 710,
    "t": ""
   },
   {
    "n": 711,
    "t": "        complete(&kthreadd_done);"
   },
   {
    "n": 712,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 717,
    "t": "        schedule_preempt_disabled();"
   },
   {
    "n": 718,
    "t": "        /* Call into cpu_idle with preempt disabled */"
   },
   {
    "n": 719,
    "t": "        cpu_startup_entry(CPUHP_ONLINE);"
   }
  ]
 },
 "lx-kinitf": {
  "file": "linux/init/main.c",
  "lang": "C",
  "lines": [
   {
    "n": 1331,
    "t": "static void __init do_basic_setup(void)"
   },
   {
    "n": 1332,
    "t": "{"
   },
   {
    "n": 1333,
    "t": "        cpuset_init_smp();"
   },
   {
    "n": 1334,
    "t": "        driver_init();"
   },
   {
    "n": 1335,
    "t": "        init_irq_proc();"
   },
   {
    "n": 1336,
    "t": "        do_ctors();"
   },
   {
    "n": 1337,
    "t": "        do_initcalls();"
   }
  ]
 },
 "lx-initramfs": {
  "file": "linux/init/initramfs.c",
  "lang": "C",
  "lines": [
   {
    "n": 770,
    "t": "static int __init populate_rootfs(void)"
   },
   {
    "n": 771,
    "t": "{"
   },
   {
    "n": 772,
    "t": "        initramfs_cookie = async_schedule_domain(do_populate_rootfs, NULL,"
   },
   {
    "n": 773,
    "t": "                                                 &initramfs_domain);"
   },
   {
    "n": 774,
    "t": "        usermodehelper_enable();"
   },
   {
    "n": 775,
    "t": "        if (!initramfs_async)"
   },
   {
    "n": 776,
    "t": "                wait_for_initramfs();"
   },
   {
    "n": 777,
    "t": "        return 0;"
   },
   {
    "n": 778,
    "t": "}"
   },
   {
    "n": 779,
    "t": "rootfs_initcall(populate_rootfs);"
   }
  ]
 },
 "lx-kinit": {
  "file": "linux/init/main.c",
  "lang": "C",
  "lines": [
   {
    "n": 1431,
    "t": "static int __ref kernel_init(void *unused)"
   },
   {
    "n": 1432,
    "t": "{"
   },
   {
    "n": 1433,
    "t": "        int ret;"
   },
   {
    "n": 1434,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 1438,
    "t": "        wait_for_completion(&kthreadd_done);"
   },
   {
    "n": 1439,
    "t": ""
   },
   {
    "n": 1440,
    "t": "        kernel_init_freeable();"
   },
   {
    "gap": true
   },
   {
    "n": 1442,
    "t": "        async_synchronize_full();"
   },
   {
    "n": 1443,
    "t": ""
   },
   {
    "n": 1444,
    "t": "        system_state = SYSTEM_FREEING_INITMEM;"
   },
   {
    "n": 1445,
    "t": "        kprobe_free_init_mem();"
   },
   {
    "n": 1446,
    "t": "        ftrace_free_init_mem();"
   },
   {
    "n": 1447,
    "t": "        kgdb_free_init_mem();"
   },
   {
    "n": 1448,
    "t": "        exit_boot_config();"
   },
   {
    "n": 1449,
    "t": "        free_initmem();"
   },
   {
    "n": 1450,
    "t": "        mark_readonly();"
   },
   {
    "n": 1451,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 1456,
    "t": "        pti_finalize();"
   },
   {
    "n": 1457,
    "t": ""
   },
   {
    "n": 1458,
    "t": "        system_state = SYSTEM_RUNNING;"
   },
   {
    "n": 1459,
    "t": "        numa_default_policy();"
   },
   {
    "n": 1460,
    "t": ""
   },
   {
    "n": 1461,
    "t": "        rcu_end_inkernel_boot();"
   },
   {
    "n": 1462,
    "t": ""
   },
   {
    "n": 1463,
    "t": "        do_sysctl_args();"
   },
   {
    "n": 1464,
    "t": ""
   },
   {
    "n": 1465,
    "t": "        if (ramdisk_execute_command) {"
   },
   {
    "n": 1466,
    "t": "                ret = run_init_process(ramdisk_execute_command);"
   },
   {
    "n": 1467,
    "t": "                if (!ret)"
   },
   {
    "n": 1468,
    "t": "                        return 0;"
   },
   {
    "n": 1469,
    "t": "                pr_err(\"Failed to execute %s (error %d)\\n\","
   },
   {
    "n": 1470,
    "t": "                       ramdisk_execute_command, ret);"
   }
  ]
 },
 "lx-syscall": {
  "file": "linux/arch/x86/entry/entry_64.S",
  "lang": "汇编",
  "lines": [
   {
    "n": 87,
    "t": "SYM_CODE_START(entry_SYSCALL_64)"
   },
   {
    "n": 88,
    "t": "        UNWIND_HINT_ENTRY"
   },
   {
    "n": 89,
    "t": "        ENDBR"
   },
   {
    "n": 90,
    "t": ""
   },
   {
    "n": 91,
    "t": "        swapgs"
   },
   {
    "n": 92,
    "t": "        /* tss.sp2 is scratch space. */"
   },
   {
    "n": 93,
    "t": "        movq    %rsp, PER_CPU_VAR(cpu_tss_rw + TSS_sp2)"
   },
   {
    "n": 94,
    "t": "        SWITCH_TO_KERNEL_CR3 scratch_reg=%rsp"
   },
   {
    "n": 95,
    "t": "        movq    PER_CPU_VAR(pcpu_hot + X86_top_of_stack), %rsp"
   },
   {
    "n": 96,
    "t": ""
   },
   {
    "n": 97,
    "t": "SYM_INNER_LABEL(entry_SYSCALL_64_safe_stack, SYM_L_GLOBAL)"
   },
   {
    "n": 98,
    "t": "        ANNOTATE_NOENDBR"
   },
   {
    "n": 99,
    "t": ""
   },
   {
    "n": 100,
    "t": "        /* Construct struct pt_regs on stack */"
   },
   {
    "n": 101,
    "t": "        pushq   $__USER_DS                              /* pt_regs->ss */"
   },
   {
    "n": 102,
    "t": "        pushq   PER_CPU_VAR(cpu_tss_rw + TSS_sp2)       /* pt_regs->sp */"
   },
   {
    "n": 103,
    "t": "        pushq   %r11                                    /* pt_regs->flags */"
   },
   {
    "n": 104,
    "t": "        pushq   $__USER_CS                              /* pt_regs->cs */"
   },
   {
    "n": 105,
    "t": "        pushq   %rcx                                    /* pt_regs->ip */"
   },
   {
    "n": 106,
    "t": "SYM_INNER_LABEL(entry_SYSCALL_64_after_hwframe, SYM_L_GLOBAL)"
   },
   {
    "n": 107,
    "t": "        pushq   %rax                                    /* pt_regs->orig_ax */"
   },
   {
    "n": 108,
    "t": ""
   },
   {
    "n": 109,
    "t": "        PUSH_AND_CLEAR_REGS rax=$-ENOSYS"
   },
   {
    "n": 110,
    "t": ""
   },
   {
    "n": 111,
    "t": "        /* IRQs are off. */"
   },
   {
    "n": 112,
    "t": "        movq    %rsp, %rdi"
   },
   {
    "gap": true
   },
   {
    "n": 114,
    "t": "        movslq  %eax, %rsi"
   },
   {
    "n": 115,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 117,
    "t": "        IBRS_ENTER"
   },
   {
    "n": 118,
    "t": "        UNTRAIN_RET"
   },
   {
    "n": 119,
    "t": "        CLEAR_BRANCH_HISTORY"
   },
   {
    "n": 120,
    "t": ""
   },
   {
    "n": 121,
    "t": "        call    do_syscall_64           /* returns with IRQs disabled */"
   }
  ]
 },
 "ix-init": {
  "file": "initramfs/init",
  "lang": "脚本",
  "lines": [
   {
    "n": 1,
    "t": "#!/bin/sh"
   },
   {
    "n": 2,
    "t": "/bin/mount -t devtmpfs devtmpfs /dev"
   },
   {
    "n": 3,
    "t": "/bin/mount -t proc proc /proc"
   },
   {
    "n": 4,
    "t": "/bin/mount -t sysfs sysfs /sys"
   },
   {
    "n": 5,
    "t": "while [ ! -b /dev/vda ]; do /bin/sleep 0.1; done"
   },
   {
    "n": 6,
    "t": "/bin/mount -t ext2 /dev/vda /newroot || exec /bin/sh"
   },
   {
    "n": 7,
    "t": "/bin/mount --move /dev /newroot/dev"
   },
   {
    "n": 8,
    "t": "/bin/mount --move /proc /newroot/proc"
   },
   {
    "n": 9,
    "t": "/bin/mount --move /sys /newroot/sys"
   },
   {
    "n": 10,
    "t": "exec /bin/switch_root /newroot /sbin/init"
   }
  ]
 },
 "lx-ext2": {
  "file": "linux/fs/ext2/super.c",
  "lang": "C",
  "lines": [
   {
    "n": 865,
    "t": "if (!(bh = sb_bread(sb, logic_sb_block))) {"
   },
   {
    "n": 866,
    "t": "        ext2_msg(sb, KERN_ERR, \"error: unable to read superblock\");"
   },
   {
    "n": 867,
    "t": "        goto failed_sbi;"
   },
   {
    "n": 868,
    "t": "}"
   },
   {
    "gap": true
   },
   {
    "n": 873,
    "t": "es = (struct ext2_super_block *) (((char *)bh->b_data) + offset);"
   },
   {
    "n": 874,
    "t": "sbi->s_es = es;"
   },
   {
    "n": 875,
    "t": "sb->s_magic = le16_to_cpu(es->s_magic);"
   },
   {
    "n": 876,
    "t": ""
   },
   {
    "n": 877,
    "t": "if (sb->s_magic != EXT2_SUPER_MAGIC)"
   }
  ]
 },
 "rf-inittab": {
  "file": "rootfs/etc/inittab",
  "lang": "配置",
  "lines": [
   {
    "n": 1,
    "t": "::sysinit:/etc/rcS"
   },
   {
    "n": 2,
    "t": "tty1::askfirst:/bin/sh -l"
   },
   {
    "n": 3,
    "t": "ttyS0::respawn:/bin/cttyhack /bin/sh -l"
   },
   {
    "n": 4,
    "t": "::ctrlaltdel:/sbin/reboot"
   },
   {
    "n": 5,
    "t": "::shutdown:/bin/sync"
   }
  ]
 },
 "rf-rcs": {
  "file": "rootfs/etc/rcS",
  "lang": "脚本",
  "lines": [
   {
    "n": 2,
    "t": "mount -t proc proc /proc 2>/dev/null"
   },
   {
    "n": 3,
    "t": "mount -t sysfs sysfs /sys 2>/dev/null"
   },
   {
    "n": 4,
    "t": "mount -t devtmpfs devtmpfs /dev 2>/dev/null"
   },
   {
    "n": 5,
    "t": "mkdir -p /dev/pts /sys/kernel/debug /sys/kernel/tracing"
   },
   {
    "n": 6,
    "t": "mount -t devpts devpts /dev/pts"
   },
   {
    "n": 7,
    "t": "mount -t debugfs debugfs /sys/kernel/debug"
   },
   {
    "n": 8,
    "t": "mount -t tracefs tracefs /sys/kernel/tracing"
   },
   {
    "n": 9,
    "t": "hostname linux-lab"
   },
   {
    "n": 10,
    "t": "printf '\\nLinux Observatory / Linux 6.12.112\\n'"
   },
   {
    "n": 11,
    "t": "printf 'Real kernel, real processes, real virtio disk.\\n'"
   },
   {
    "n": 12,
    "t": "printf 'Try: cat /data/hello.txt; lab-read; lab-memory; lab-cow\\n\\n'"
   }
  ]
 },
 "lx-idle": {
  "file": "linux/arch/x86/kernel/process.c",
  "lang": "C",
  "lines": [
   {
    "n": 751,
    "t": "void __cpuidle default_idle(void)"
   },
   {
    "n": 752,
    "t": "{"
   },
   {
    "n": 753,
    "t": "        raw_safe_halt();"
   }
  ]
 },
 "lx-8250": {
  "file": "linux/drivers/tty/serial/8250/8250_port.c",
  "lang": "C",
  "lines": [
   {
    "n": 1686,
    "t": "void serial8250_read_char(struct uart_8250_port *up, u16 lsr)"
   },
   {
    "n": 1687,
    "t": "{"
   },
   {
    "n": 1688,
    "t": "        struct uart_port *port = &up->port;"
   },
   {
    "n": 1689,
    "t": "        u8 ch, flag = TTY_NORMAL;"
   },
   {
    "n": 1690,
    "t": ""
   },
   {
    "n": 1691,
    "t": "        if (likely(lsr & UART_LSR_DR))"
   },
   {
    "n": 1692,
    "t": "                ch = serial_in(up, UART_RX);"
   }
  ]
 },
 "lx-ntty": {
  "file": "linux/drivers/tty/n_tty.c",
  "lang": "C",
  "lines": [
   {
    "n": 1424,
    "t": "static void n_tty_receive_char(struct tty_struct *tty, u8 c)"
   },
   {
    "n": 1425,
    "t": "{"
   },
   {
    "n": 1426,
    "t": "        struct n_tty_data *ldata = tty->disc_data;"
   },
   {
    "n": 1427,
    "t": ""
   },
   {
    "n": 1428,
    "t": "        if (tty->flow.stopped && !tty->flow.tco_stopped && I_IXON(tty) && I_IXANY(tty)) {"
   },
   {
    "n": 1429,
    "t": "                start_tty(tty);"
   },
   {
    "n": 1430,
    "t": "                process_echoes(tty);"
   },
   {
    "n": 1431,
    "t": "        }"
   },
   {
    "n": 1432,
    "t": "        if (L_ECHO(tty)) {"
   },
   {
    "n": 1433,
    "t": "                finish_erasing(ldata);"
   },
   {
    "n": 1434,
    "t": "                /* Record the column of first canon char. */"
   },
   {
    "n": 1435,
    "t": "                if (ldata->canon_head == ldata->read_head)"
   },
   {
    "n": 1436,
    "t": "                        echo_set_canon_col(ldata);"
   },
   {
    "n": 1437,
    "t": "                echo_char(c, tty);"
   },
   {
    "n": 1438,
    "t": "                commit_echoes(tty);"
   },
   {
    "n": 1439,
    "t": "        }"
   },
   {
    "n": 1440,
    "t": "        /* PARMRK doubling check */"
   },
   {
    "n": 1441,
    "t": "        if (c == '\\377' && I_PARMRK(tty))"
   },
   {
    "n": 1442,
    "t": "                put_tty_queue(c, ldata);"
   },
   {
    "n": 1443,
    "t": "        put_tty_queue(c, ldata);"
   }
  ]
 },
 "pr-asm": {
  "file": "docs/animation/boot/primer.asm",
  "lang": "汇编",
  "lines": [
   {
    "n": 1,
    "t": "; 演示程序（不是开机代码）：16 位实模式，NASM 语法"
   },
   {
    "n": 2,
    "t": "; 放在物理地址 0x10000：CS = 0x1000，IP = 0"
   },
   {
    "n": 3,
    "t": "; 栈：SS = 0x3000，SP = 0x0100；数据：0x20010 处存着 7"
   },
   {
    "n": 4,
    "t": "        org  0"
   },
   {
    "n": 5,
    "t": "start:"
   },
   {
    "n": 6,
    "t": "        mov  ax, 0x2000      ; B8 00 20"
   },
   {
    "n": 7,
    "t": "        mov  ds, ax          ; 8E D8"
   },
   {
    "n": 8,
    "t": "        mov  ax, [0x0010]    ; A1 10 00"
   },
   {
    "n": 9,
    "t": "        add  ax, 5           ; 05 05 00"
   },
   {
    "n": 10,
    "t": "        mov  [0x0012], ax    ; A3 12 00"
   },
   {
    "n": 11,
    "t": "        push ax              ; 50"
   },
   {
    "n": 12,
    "t": "        call double          ; E8 04 00"
   },
   {
    "n": 13,
    "t": "        pop  bx              ; 5B"
   },
   {
    "n": 14,
    "t": "        hlt                  ; F4"
   },
   {
    "n": 15,
    "t": "        jmp  start           ; EB EA"
   },
   {
    "n": 16,
    "t": ""
   },
   {
    "n": 17,
    "t": "double:"
   },
   {
    "n": 18,
    "t": "        add  ax, ax          ; 01 C0"
   },
   {
    "n": 19,
    "t": "        ret                  ; C3"
   }
  ]
 },
 "sb-irq08": {
  "file": "seabios/src/clock.c",
  "lang": "C",
  "lines": [
   {
    "n": 301,
    "t": "// INT 08h System Timer ISR Entry Point"
   },
   {
    "n": 302,
    "t": "void VISIBLE16"
   },
   {
    "n": 303,
    "t": "handle_08(void)"
   },
   {
    "n": 304,
    "t": "{"
   },
   {
    "n": 305,
    "t": "    debug_isr(DEBUG_ISR_08);"
   },
   {
    "n": 306,
    "t": "    clock_update();"
   },
   {
    "n": 307,
    "t": ""
   },
   {
    "n": 308,
    "t": "    // chain to user timer tick INT #0x1c"
   },
   {
    "n": 309,
    "t": "    struct bregs br;"
   },
   {
    "n": 310,
    "t": "    memset(&br, 0, sizeof(br));"
   },
   {
    "n": 311,
    "t": "    br.flags = F_IF;"
   },
   {
    "n": 312,
    "t": "    call16_int(0x1c, &br);"
   },
   {
    "n": 313,
    "t": ""
   },
   {
    "n": 314,
    "t": "    pic_eoi1();"
   }
  ]
 },
 "lx-ctxsw": {
  "file": "linux/kernel/sched/core.c",
  "lang": "C",
  "lines": [
   {
    "n": 5307,
    "t": "context_switch(struct rq *rq, struct task_struct *prev,"
   },
   {
    "n": 5308,
    "t": "               struct task_struct *next, struct rq_flags *rf)"
   },
   {
    "n": 5309,
    "t": "{"
   },
   {
    "n": 5310,
    "t": "        prepare_task_switch(rq, prev, next);"
   },
   {
    "n": 5311,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 5317,
    "t": "        arch_start_context_switch(prev);"
   },
   {
    "n": 5318,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 5329,
    "t": "        if (!next->mm) {                                // to kernel"
   },
   {
    "n": 5330,
    "t": "                enter_lazy_tlb(prev->active_mm, next);"
   },
   {
    "n": 5331,
    "t": ""
   },
   {
    "n": 5332,
    "t": "                next->active_mm = prev->active_mm;"
   },
   {
    "n": 5333,
    "t": "                if (prev->mm)                           // from user"
   },
   {
    "n": 5334,
    "t": "                        mmgrab_lazy_tlb(prev->active_mm);"
   },
   {
    "n": 5335,
    "t": "                else"
   },
   {
    "n": 5336,
    "t": "                        prev->active_mm = NULL;"
   },
   {
    "n": 5337,
    "t": "        } else {                                        // to user"
   },
   {
    "n": 5338,
    "t": "                membarrier_switch_mm(rq, prev->active_mm, next->mm);"
   },
   {
    "gap": true
   },
   {
    "n": 5347,
    "t": "                switch_mm_irqs_off(prev->active_mm, next->mm, next);"
   },
   {
    "n": 5348,
    "t": "                lru_gen_use_mm(next->mm);"
   },
   {
    "n": 5349,
    "t": ""
   },
   {
    "n": 5350,
    "t": "                if (!prev->mm) {                        // from kernel"
   },
   {
    "gap": true
   },
   {
    "n": 5352,
    "t": "                        rq->prev_mm = prev->active_mm;"
   },
   {
    "n": 5353,
    "t": "                        prev->active_mm = NULL;"
   },
   {
    "n": 5354,
    "t": "                }"
   },
   {
    "n": 5355,
    "t": "        }"
   },
   {
    "n": 5356,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 5358,
    "t": "        switch_mm_cid(rq, prev, next);"
   },
   {
    "n": 5359,
    "t": ""
   },
   {
    "n": 5360,
    "t": "        prepare_lock_switch(rq, next, rf);"
   },
   {
    "n": 5361,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 5363,
    "t": "        switch_to(prev, next, prev);"
   },
   {
    "n": 5364,
    "t": "        barrier();"
   },
   {
    "n": 5365,
    "t": ""
   },
   {
    "n": 5366,
    "t": "        return finish_task_switch(prev);"
   }
  ]
 },
 "lx-swasm": {
  "file": "linux/arch/x86/entry/entry_64.S",
  "lang": "汇编",
  "lines": [
   {
    "n": 177,
    "t": "SYM_FUNC_START(__switch_to_asm)"
   },
   {
    "gap": true
   },
   {
    "n": 182,
    "t": "        pushq   %rbp"
   },
   {
    "n": 183,
    "t": "        pushq   %rbx"
   },
   {
    "n": 184,
    "t": "        pushq   %r12"
   },
   {
    "n": 185,
    "t": "        pushq   %r13"
   },
   {
    "n": 186,
    "t": "        pushq   %r14"
   },
   {
    "n": 187,
    "t": "        pushq   %r15"
   },
   {
    "n": 188,
    "t": ""
   },
   {
    "n": 189,
    "t": "        /* switch stack */"
   },
   {
    "n": 190,
    "t": "        movq    %rsp, TASK_threadsp(%rdi)"
   },
   {
    "n": 191,
    "t": "        movq    TASK_threadsp(%rsi), %rsp"
   },
   {
    "n": 192,
    "t": ""
   },
   {
    "n": 194,
    "t": "        movq    TASK_stack_canary(%rsi), %rbx"
   },
   {
    "n": 195,
    "t": "        movq    %rbx, PER_CPU_VAR(fixed_percpu_data + FIXED_stack_canary)"
   },
   {
    "n": 197,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 205,
    "t": "        FILL_RETURN_BUFFER %r12, RSB_CLEAR_LOOPS, X86_FEATURE_RSB_CTXSW"
   },
   {
    "n": 206,
    "t": ""
   },
   {
    "n": 207,
    "t": "        /* restore callee-saved registers */"
   },
   {
    "n": 208,
    "t": "        popq    %r15"
   },
   {
    "n": 209,
    "t": "        popq    %r14"
   },
   {
    "n": 210,
    "t": "        popq    %r13"
   },
   {
    "n": 211,
    "t": "        popq    %r12"
   },
   {
    "n": 212,
    "t": "        popq    %rbx"
   },
   {
    "n": 213,
    "t": "        popq    %rbp"
   },
   {
    "n": 214,
    "t": ""
   },
   {
    "n": 215,
    "t": "        jmp     __switch_to"
   }
  ]
 },
 "lx-loadcr3": {
  "file": "linux/arch/x86/mm/tlb.c",
  "lang": "C",
  "lines": [
   {
    "n": 280,
    "t": "static void load_new_mm_cr3(pgd_t *pgdir, u16 new_asid, unsigned long lam,"
   },
   {
    "n": 281,
    "t": "                            bool need_flush)"
   },
   {
    "n": 282,
    "t": "{"
   },
   {
    "n": 283,
    "t": "        unsigned long new_mm_cr3;"
   },
   {
    "n": 284,
    "t": ""
   },
   {
    "n": 285,
    "t": "        if (need_flush) {"
   },
   {
    "n": 286,
    "t": "                invalidate_user_asid(new_asid);"
   },
   {
    "n": 287,
    "t": "                new_mm_cr3 = build_cr3(pgdir, new_asid, lam);"
   },
   {
    "n": 288,
    "t": "        } else {"
   },
   {
    "n": 289,
    "t": "                new_mm_cr3 = build_cr3_noflush(pgdir, new_asid, lam);"
   },
   {
    "n": 290,
    "t": "        }"
   },
   {
    "n": 291,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 297,
    "t": "        write_cr3(new_mm_cr3);"
   }
  ]
 },
 "lx-pgdctor": {
  "file": "linux/arch/x86/mm/pgtable.c",
  "lang": "C",
  "lines": [
   {
    "n": 126,
    "t": "static void pgd_ctor(struct mm_struct *mm, pgd_t *pgd)"
   },
   {
    "n": 127,
    "t": "{"
   },
   {
    "gap": true
   },
   {
    "n": 131,
    "t": "        if (CONFIG_PGTABLE_LEVELS == 2 ||"
   },
   {
    "n": 132,
    "t": "            (CONFIG_PGTABLE_LEVELS == 3 && SHARED_KERNEL_PMD) ||"
   },
   {
    "n": 133,
    "t": "            CONFIG_PGTABLE_LEVELS >= 4) {"
   },
   {
    "n": 134,
    "t": "                clone_pgd_range(pgd + KERNEL_PGD_BOUNDARY,"
   },
   {
    "n": 135,
    "t": "                                swapper_pg_dir + KERNEL_PGD_BOUNDARY,"
   },
   {
    "n": 136,
    "t": "                                KERNEL_PGD_PTRS);"
   }
  ]
 },
 "lx-execmmap": {
  "file": "linux/fs/exec.c",
  "lang": "C",
  "lines": [
   {
    "n": 962,
    "t": "static int exec_mmap(struct mm_struct *mm)"
   },
   {
    "n": 963,
    "t": "{"
   },
   {
    "n": 964,
    "t": "        struct task_struct *tsk;"
   },
   {
    "n": 965,
    "t": "        struct mm_struct *old_mm, *active_mm;"
   },
   {
    "n": 966,
    "t": "        int ret;"
   },
   {
    "n": 967,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 969,
    "t": "        tsk = current;"
   },
   {
    "n": 970,
    "t": "        old_mm = current->mm;"
   },
   {
    "n": 971,
    "t": "        exec_mm_release(tsk, old_mm);"
   },
   {
    "n": 972,
    "t": ""
   },
   {
    "n": 973,
    "t": "        ret = down_write_killable(&tsk->signal->exec_update_lock);"
   },
   {
    "n": 974,
    "t": "        if (ret)"
   },
   {
    "n": 975,
    "t": "                return ret;"
   },
   {
    "n": 976,
    "t": ""
   },
   {
    "n": 977,
    "t": "        if (old_mm) {"
   },
   {
    "gap": true
   },
   {
    "n": 983,
    "t": "                ret = mmap_read_lock_killable(old_mm);"
   },
   {
    "n": 984,
    "t": "                if (ret) {"
   },
   {
    "n": 985,
    "t": "                        up_write(&tsk->signal->exec_update_lock);"
   },
   {
    "n": 986,
    "t": "                        return ret;"
   },
   {
    "n": 987,
    "t": "                }"
   },
   {
    "n": 988,
    "t": "        }"
   },
   {
    "n": 989,
    "t": ""
   },
   {
    "n": 990,
    "t": "        task_lock(tsk);"
   },
   {
    "n": 991,
    "t": "        membarrier_exec_mmap(mm);"
   },
   {
    "n": 992,
    "t": ""
   },
   {
    "n": 993,
    "t": "        local_irq_disable();"
   },
   {
    "n": 994,
    "t": "        active_mm = tsk->active_mm;"
   },
   {
    "n": 995,
    "t": "        tsk->active_mm = mm;"
   },
   {
    "n": 996,
    "t": "        tsk->mm = mm;"
   },
   {
    "n": 997,
    "t": "        mm_init_cid(mm);"
   },
   {
    "gap": true
   },
   {
    "n": 1005,
    "t": "        if (!IS_ENABLED(CONFIG_ARCH_WANT_IRQS_OFF_ACTIVATE_MM))"
   },
   {
    "n": 1006,
    "t": "                local_irq_enable();"
   },
   {
    "n": 1007,
    "t": "        activate_mm(active_mm, mm);"
   }
  ]
 },
 "lx-pf": {
  "file": "linux/arch/x86/mm/fault.c",
  "lang": "C",
  "lines": [
   {
    "n": 1488,
    "t": "DEFINE_IDTENTRY_RAW_ERRORCODE(exc_page_fault)"
   },
   {
    "n": 1489,
    "t": "{"
   },
   {
    "n": 1490,
    "t": "        irqentry_state_t state;"
   },
   {
    "n": 1491,
    "t": "        unsigned long address;"
   },
   {
    "n": 1492,
    "t": ""
   },
   {
    "n": 1493,
    "t": "        address = cpu_feature_enabled(X86_FEATURE_FRED) ? fred_event_data(regs) : read_cr2();"
   },
   {
    "n": 1494,
    "t": ""
   },
   {
    "n": 1495,
    "t": "        prefetchw(&current->mm->mmap_lock);"
   },
   {
    "n": 1496,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 1518,
    "t": "        if (kvm_handle_async_pf(regs, (u32)address))"
   },
   {
    "n": 1519,
    "t": "                return;"
   },
   {
    "n": 1520,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 1531,
    "t": "        state = irqentry_enter(regs);"
   },
   {
    "n": 1532,
    "t": ""
   },
   {
    "n": 1533,
    "t": "        instrumentation_begin();"
   },
   {
    "n": 1534,
    "t": "        handle_page_fault(regs, error_code, address);"
   }
  ]
 },
 "lx-cow": {
  "file": "linux/mm/memory.c",
  "lang": "C",
  "lines": [
   {
    "n": 950,
    "t": "static __always_inline void __copy_present_ptes(struct vm_area_struct *dst_vma,"
   },
   {
    "n": 951,
    "t": "                struct vm_area_struct *src_vma, pte_t *dst_pte, pte_t *src_pte,"
   },
   {
    "n": 952,
    "t": "                pte_t pte, unsigned long addr, int nr)"
   },
   {
    "n": 953,
    "t": "{"
   },
   {
    "n": 954,
    "t": "        struct mm_struct *src_mm = src_vma->vm_mm;"
   },
   {
    "n": 955,
    "t": ""
   },
   {
    "gap": true
   },
   {
    "n": 957,
    "t": "        if (is_cow_mapping(src_vma->vm_flags) && pte_write(pte)) {"
   },
   {
    "n": 958,
    "t": "                wrprotect_ptes(src_mm, addr, src_pte, nr);"
   },
   {
    "n": 959,
    "t": "                pte = pte_wrprotect(pte);"
   }
  ]
 },
 "lx-npoll": {
  "file": "linux/drivers/tty/n_tty.c",
  "lang": "C",
  "lines": [
   {
    "n": 2458,
    "t": "static __poll_t n_tty_poll(struct tty_struct *tty, struct file *file,"
   },
   {
    "n": 2459,
    "t": "                                                        poll_table *wait)"
   },
   {
    "n": 2460,
    "t": "{"
   },
   {
    "n": 2461,
    "t": "        __poll_t mask = 0;"
   },
   {
    "n": 2462,
    "t": ""
   },
   {
    "n": 2463,
    "t": "        poll_wait(file, &tty->read_wait, wait);"
   },
   {
    "n": 2464,
    "t": "        poll_wait(file, &tty->write_wait, wait);"
   },
   {
    "n": 2465,
    "t": "        if (input_available_p(tty, 1))"
   },
   {
    "n": 2466,
    "t": "                mask |= EPOLLIN | EPOLLRDNORM;"
   }
  ]
 }
};
