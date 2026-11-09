"""Ephemeral local SFTP server for adapter acceptance, not a production server."""
import os,socket,sys,threading,time,json,paramiko
root=sys.argv[1]
class Auth(paramiko.ServerInterface):
 def check_auth_password(self,u,p):return paramiko.AUTH_SUCCESSFUL if (u,p)==('tester','isolated-password') else paramiko.AUTH_FAILED
 def get_allowed_auths(self,u):return 'password'
 def check_channel_request(self,k,c):return paramiko.OPEN_SUCCEEDED if k=='session' else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED
class Files(paramiko.SFTPServerInterface):
 def path(self,p):
  p=os.path.normpath('/'+p.lstrip('/'));return root+p
 def stat(self,p):
  try:return paramiko.SFTPAttributes.from_stat(os.stat(self.path(p)))
  except OSError as e:return paramiko.SFTPServer.convert_errno(e.errno)
 def lstat(self,p):
  try:return paramiko.SFTPAttributes.from_stat(os.lstat(self.path(p)))
  except OSError as e:return paramiko.SFTPServer.convert_errno(e.errno)
 def list_folder(self,p):
  try:
   out=[]
   for n in os.listdir(self.path(p)):
    a=paramiko.SFTPAttributes.from_stat(os.lstat(self.path(p)+'/'+n));a.filename=n;out.append(a)
   return out
  except OSError as e:return paramiko.SFTPServer.convert_errno(e.errno)
 def open(self,p,flags,attr):
  try:
   fd=os.open(self.path(p),flags,0o600);mode='r+b' if flags & os.O_RDWR else 'wb' if flags & os.O_WRONLY else 'rb';f=os.fdopen(fd,mode);h=paramiko.SFTPHandle(flags);h.readfile=f;h.writefile=f;return h
  except OSError as e:return paramiko.SFTPServer.convert_errno(e.errno)
 def remove(self,p):
  try:os.unlink(self.path(p));return paramiko.SFTP_OK
  except OSError as e:return paramiko.SFTPServer.convert_errno(e.errno)
 def rename(self,a,b):
  try:
   if os.path.exists(self.path(b)):return paramiko.SFTP_FAILURE
   os.rename(self.path(a),self.path(b));return paramiko.SFTP_OK
  except OSError as e:return paramiko.SFTPServer.convert_errno(e.errno)
 def posix_rename(self,a,b):
  try:os.replace(self.path(a),self.path(b));return paramiko.SFTP_OK
  except OSError as e:return paramiko.SFTPServer.convert_errno(e.errno)
key=paramiko.RSAKey.generate(2048);s=socket.socket();s.bind(('127.0.0.1',0));s.listen(20)
print(json.dumps({'port':s.getsockname()[1],'hostKey':key.get_name()+' '+key.get_base64()}),flush=True)
def serve(c):
 t=paramiko.Transport(c);t.add_server_key(key);t.set_subsystem_handler('sftp',paramiko.SFTPServer,Files)
 try:
  t.start_server(server=Auth())
  while t.is_active():time.sleep(.05)
 finally:t.close()
while True:
 c,_=s.accept();threading.Thread(target=serve,args=(c,),daemon=True).start()
