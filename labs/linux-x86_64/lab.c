#define _GNU_SOURCE
#include <sys/types.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <termios.h>
#include <errno.h>

volatile unsigned long lab_phase;
volatile void *lab_buffer;
volatile long lab_result;
__attribute__((noinline)) void lab_checkpoint(unsigned long phase) {
  lab_phase = phase;
  __asm__ volatile("nop" ::: "memory");
}
static void fail(const char *what) { perror(what); exit(1); }
static void read_file(const char *path) {
  char buffer[4096];
  int fd=open(path,O_RDONLY); if(fd<0) fail("open");
  lab_buffer=buffer; lab_result=fd; lab_checkpoint(10);
  ssize_t n=read(fd,buffer,sizeof buffer); if(n<0) fail("read");
  lab_result=n; lab_checkpoint(11);
  if(write(STDOUT_FILENO,buffer,(size_t)n)<0) fail("write");
  lab_checkpoint(12); close(fd);
}
static void write_file(const char *path) {
  const char text[]="Written by a real Linux process.\n";
  int fd=open(path,O_CREAT|O_TRUNC|O_RDWR,0644); if(fd<0) fail("open");
  lab_buffer=text; lab_checkpoint(20);
  lab_result=write(fd,text,sizeof(text)-1); if(lab_result<0) fail("write");
  lab_checkpoint(21); if(fsync(fd)<0) fail("fsync");
  lab_checkpoint(22); close(fd); read_file(path);
}
static void memory_lab(int cow) {
  char *p=mmap(NULL,3*4096,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
  if(p==MAP_FAILED) fail("mmap");
  lab_buffer=p; printf("pid=%d mapping=%p\n",getpid(),(void*)p); lab_checkpoint(30);
  p[0]='A'; p[4096]='B'; lab_checkpoint(31);
  if(cow) {
    pid_t pid=fork(); if(pid<0) fail("fork");
    if(!pid) { lab_checkpoint(32); p[0]='C'; lab_checkpoint(33); printf("child=%d byte=%c\n",getpid(),p[0]); _exit(0); }
    waitpid(pid,NULL,0); printf("parent=%d byte=%c\n",getpid(),p[0]);
  }
  lab_checkpoint(34); munmap(p,3*4096);
}
static void process_lab(void) {
  lab_checkpoint(40); pid_t pid=fork(); if(pid<0) fail("fork");
  if(!pid) { lab_checkpoint(41); execl("/bin/echo","echo","Hello after exec",NULL); fail("exec"); }
  int status=0; waitpid(pid,&status,0); lab_result=status; lab_checkpoint(42);
  printf("reaped pid=%d status=%d\n",pid,status);
}
static void mmap_file(const char *path) {
  int fd=open(path,O_RDWR); if(fd<0) fail("open");
  struct stat st; if(fstat(fd,&st)<0 || !st.st_size) fail("fstat");
  char *p=mmap(NULL,(size_t)st.st_size,PROT_READ|PROT_WRITE,MAP_SHARED,fd,0);
  if(p==MAP_FAILED) fail("mmap"); lab_buffer=p; lab_checkpoint(50);
  p[0]='M'; lab_checkpoint(51); if(msync(p,(size_t)st.st_size,MS_SYNC)<0) fail("msync");
  lab_checkpoint(52); munmap(p,(size_t)st.st_size); close(fd);
}
static void alloc_lab(void) {
  void *a=malloc(64*1024); void *b=malloc(256*1024); void *c=calloc(1,4096);
  if(!a||!b||!c) fail("malloc");
  memset(a,'A',64*1024); memset(b,'B',256*1024);
  lab_buffer=a; lab_result=(long)((char*)b-(char*)a); lab_checkpoint(90);
  free(a); free(b); free(c); lab_checkpoint(91);
  void *d=malloc(1024*1024); if(!d) fail("malloc2"); memset(d,'D',1024*1024);
  lab_buffer=d; lab_checkpoint(92); free(d);
  printf("malloc/free done; brk=%p\n",(void*)sbrk(0));
}
static void signal_lab(void) {
  pid_t pid=fork(); if(pid<0) fail("fork");
  if(!pid) {
    lab_checkpoint(95);
    for(;;) pause();
  }
  usleep(200000);
  lab_result=(long)pid; lab_checkpoint(96);
  if(kill(pid,SIGTERM)<0) fail("kill");
  lab_checkpoint(97);
  int status=0; waitpid(pid,&status,0);
  printf("child=%d status=%d signaled=%d sig=%d\n",pid,status,WIFSIGNALED(status),WIFSIGNALED(status)?WTERMSIG(status):0);
  lab_checkpoint(98);
}
int main(int argc,char **argv) {
  const char *name=strrchr(argv[0],'/'); name=name?name+1:argv[0];
  const char *path=argc>1?argv[1]:"/data/hello.txt";
  setvbuf(stdout,NULL,_IONBF,0);
  if(!strcmp(name,"lab-read")) read_file(path);
  else if(!strcmp(name,"lab-write")) write_file(argc>1?argv[1]:"/data/written.txt");
  else if(!strcmp(name,"lab-memory")) memory_lab(0);
  else if(!strcmp(name,"lab-cow")) memory_lab(1);
  else if(!strcmp(name,"lab-fork-exec")) process_lab();
  else if(!strcmp(name,"lab-mmap-file")) mmap_file(path);
  else if(!strcmp(name,"lab-fault")) { lab_checkpoint(60); volatile char *p=mmap(NULL,4096,PROT_NONE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0); if(p==MAP_FAILED)fail("mmap"); lab_buffer=p; lab_checkpoint(61); *p=1; }
  else if(!strcmp(name,"lab-schedule")) { for(int i=0;i<4;i++){ printf("pid=%d tick=%d\n",getpid(),i); lab_checkpoint(70); sleep(1); } }
  else if(!strcmp(name,"lab-alloc")) alloc_lab();
  else if(!strcmp(name,"lab-signal")) signal_lab();
  else if(!strcmp(name,"lab-tty")) { struct termios t; if(tcgetattr(0,&t)<0)fail("tcgetattr"); t.c_lflag|=ICANON|ECHO; if(tcsetattr(0,TCSANOW,&t)<0)fail("tcsetattr"); char b[256]; puts("Canonical input: type a line and press Enter."); lab_checkpoint(80); ssize_t n=read(0,b,sizeof b); lab_result=n; lab_checkpoint(81); if(n>0)write(1,b,(size_t)n); }
  else { puts("Use lab-read, lab-write, lab-memory, lab-cow, lab-fork-exec, lab-mmap-file, lab-fault, lab-schedule, lab-alloc, lab-signal or lab-tty."); }
  return 0;
}
