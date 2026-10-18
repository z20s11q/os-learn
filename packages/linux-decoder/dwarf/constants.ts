/** DWARF 4 编码词汇表，数值来自规范第 7 章。
 * probe-dwarf.mjs 统计实际 vmlinux 的 form/tag，reader 对实现范围执行显式校验。
 */

/* ---------- form（属性值怎么编码） ---------- */

export const FORM = {
  addr: 0x01,
  block2: 0x03,
  block4: 0x04,
  data2: 0x05,
  data4: 0x06,
  data8: 0x07,
  string: 0x08,
  block: 0x09,
  block1: 0x0a,
  data1: 0x0b,
  flag: 0x0c,
  sdata: 0x0d,
  strp: 0x0e,
  udata: 0x0f,
  ref_addr: 0x10,
  ref1: 0x11,
  ref2: 0x12,
  ref4: 0x13,
  ref8: 0x14,
  ref_udata: 0x15,
  indirect: 0x16,
  sec_offset: 0x17,
  exprloc: 0x18,
  flag_present: 0x19,
  ref_sig8: 0x20,
} as const;

/** form 编号 → 名字，报错时打印人话。 */
export const FORM_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(FORM).map(([name, code]) => [code, name]),
);

/**
 * 值就是"一个整数常量"的 form。
 *
 * DW_AT_data_member_location、DW_AT_upper_bound、DW_AT_byte_size、DW_AT_const_value
 * 这些属性在不同形态下既可能是常量 form，也可能是 exprloc（一段 DWARF 表达式）。
 * 判定一个值能不能直接当数字用，就看 form 在不在这张表里。
 */
export const CONSTANT_FORMS = new Set<number>([
  FORM.data1, FORM.data2, FORM.data4, FORM.data8, FORM.sdata, FORM.udata,
]);

/** 值指向"另一个 DIE"的 form。DW_FORM_ref4 的值是**编译单元内**的偏移。 */
export const REFERENCE_FORMS = new Set<number>([
  FORM.ref1, FORM.ref2, FORM.ref4, FORM.ref8, FORM.ref_udata, FORM.ref_addr,
]);

/* ---------- tag（这个 DIE 描述的是什么东西） ---------- */

export const TAG = {
  array_type: 0x01,
  class_type: 0x02,
  enumeration_type: 0x04,
  formal_parameter: 0x05,
  lexical_block: 0x0b,
  member: 0x0d,
  pointer_type: 0x0f,
  reference_type: 0x10,
  compile_unit: 0x11,
  structure_type: 0x13,
  subroutine_type: 0x15,
  typedef: 0x16,
  union_type: 0x17,
  inheritance: 0x1c,
  inlined_subroutine: 0x1d,
  subrange_type: 0x21,
  base_type: 0x24,
  const_type: 0x26,
  enumerator: 0x28,
  packed_type: 0x2d,
  subprogram: 0x2e,
  variable: 0x34,
  volatile_type: 0x35,
  restrict_type: 0x32,
  namespace: 0x39,
} as const;

/** tag 编号 → 名字。 */
export const TAG_NAMES: Record<number, string> = {
  0x01: 'array_type', 0x02: 'class_type', 0x03: 'entry_point',
  0x04: 'enumeration_type', 0x05: 'formal_parameter', 0x08: 'imported_declaration',
  0x0a: 'label', 0x0b: 'lexical_block', 0x0d: 'member',
  0x0f: 'pointer_type', 0x10: 'reference_type', 0x11: 'compile_unit',
  0x12: 'string_type', 0x13: 'structure_type', 0x15: 'subroutine_type',
  0x16: 'typedef', 0x17: 'union_type', 0x18: 'unspecified_parameters',
  0x1c: 'inheritance', 0x1d: 'inlined_subroutine', 0x21: 'subrange_type',
  0x24: 'base_type', 0x25: 'catch_block', 0x26: 'const_type',
  0x27: 'constant', 0x28: 'enumerator', 0x29: 'file_type',
  0x2d: 'packed_type', 0x2e: 'subprogram', 0x2f: 'template_type_parameter',
  0x30: 'template_value_parameter', 0x32: 'restrict_type', 0x34: 'variable',
  0x35: 'volatile_type', 0x37: 'unspecified_type', 0x39: 'namespace',
};

/** 类型包装 tag，通过 DW_AT_type 引用定位本体。 */
export const TYPE_WRAPPER_TAGS = new Set<number>([
  TAG.const_type, TAG.volatile_type, TAG.restrict_type, TAG.typedef, TAG.packed_type,
]);

/** 复合类型（有成员、有自己名字、有 byte_size）。 */
export const COMPOSITE_TAGS = new Set<number>([
  TAG.structure_type, TAG.union_type, TAG.class_type,
]);

/* ---------- attribute（这个 DIE 的某个性质） ---------- */

export const ATTR = {
  sibling: 0x01,
  location: 0x02,
  name: 0x03,
  byte_size: 0x0b,
  bit_offset: 0x0c,
  bit_size: 0x0d,
  stmt_list: 0x10,
  low_pc: 0x11,
  high_pc: 0x12,
  language: 0x13,
  comp_dir: 0x1b,
  const_value: 0x1c,
  upper_bound: 0x2f,
  count: 0x37,
  lower_bound: 0x22,
  producer: 0x25,
  declaration: 0x3c,
  data_member_location: 0x38,
  encoding: 0x3e,
  specification: 0x47,
  type: 0x49,
  abstract_origin: 0x31,
  external: 0x3f,
  data_bit_offset: 0x6b,
  alignment: 0x88,
} as const;

/** attr 编号 → 名字，报错和调试时打印人话。 */
export const ATTR_NAMES: Record<number, string> = {
  0x01: 'sibling', 0x02: 'location', 0x03: 'name', 0x0b: 'byte_size',
  0x0c: 'bit_offset', 0x0d: 'bit_size', 0x10: 'stmt_list', 0x11: 'low_pc',
  0x12: 'high_pc', 0x13: 'language', 0x1b: 'comp_dir', 0x1c: 'const_value',
  0x22: 'lower_bound', 0x25: 'producer', 0x2e: 'bit_stride',
  0x2f: 'upper_bound', 0x31: 'abstract_origin', 0x37: 'count',
  0x38: 'data_member_location', 0x3c: 'declaration', 0x3e: 'encoding',
  0x3f: 'external', 0x47: 'specification', 0x49: 'type', 0x6b: 'data_bit_offset',
  0x88: 'alignment',
};

/* ---------- 基础类型编码 ---------- */

/** DW_AT_encoding 的取值，用来判断"这是有符号整数还是浮点"。 */
export const ENCODING: Record<number, string> = {
  0x01: 'address',
  0x02: 'boolean',
  0x03: 'complex_float',
  0x04: 'float',
  0x05: 'signed',
  0x06: 'signed_char',
  0x07: 'unsigned',
  0x08: 'unsigned_char',
};

/* ---------- DWARF 表达式的 opcode（我们只认几个） ---------- */

export const DW_OP = {
  addr: 0x03,
  const1u: 0x08,
  const1s: 0x09,
  const2u: 0x0a,
  const2s: 0x0b,
  const4u: 0x0c,
  const4s: 0x0d,
  const8u: 0x0e,
  const8s: 0x0f,
  plus_uconst: 0x23,
} as const;
