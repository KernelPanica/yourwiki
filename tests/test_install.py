import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import pytest
ROOT=Path(__file__).resolve().parents[1]

def setup_config(tmp_path):
    config={'public_url':'http://localhost:3000','admin':{'username':'owner','display_name':'Owner','password':'Very-long-password-3927'},'storage':{'provider':'local','root':str(tmp_path/'documents')}}
    file=tmp_path/'setup.json';file.write_text(json.dumps(config));file.chmod(0o600)
    env={**os.environ,'YOURWIKI_DATA':str(tmp_path/'db'),'YOURWIKI_SECRETS':str(tmp_path/'secrets'),'YOURWIKI_DOCUMENTS':str(tmp_path/'documents')}
    return file,env,config

def run_setup(file,env,*extra):
    return subprocess.run([sys.executable,str(ROOT/'install.py'),'--allow-http','--config',str(file),*extra],env=env,cwd=ROOT,capture_output=True,text=True,timeout=30)


def test_fresh_setup_rerun_and_reconnect(tmp_path):
    file,env,config=setup_config(tmp_path)
    result=run_setup(file,env)
    assert result.returncode==0,result.stdout+result.stderr
    assert config['admin']['password'] not in result.stdout+result.stderr
    db=sqlite3.connect(Path(env['YOURWIKI_DATA'])/'wiki.sqlite3')
    try:
        assert db.execute('select username,is_superuser from wiki_user').fetchall()==[('owner',1)]
        assert db.execute('select initialized from wiki_workspace').fetchone()[0]==1
        assert db.execute('pragma journal_mode').fetchone()[0]=='wal'
        password=db.execute('select password from wiki_user').fetchone()[0]
        assert password!=config['admin']['password']
    finally:db.close()
    assert (Path(env['YOURWIKI_SECRETS'])/'encryption.key').stat().st_mode&0o777==0o600
    second=run_setup(file,env)
    assert second.returncode==1 and 'Already initialized' in second.stdout
    reconnect=run_setup(file,env,'--reconnect')
    assert reconnect.returncode==0,reconnect.stdout+reconnect.stderr
    config['storage']['root']=str(tmp_path/'different')
    file.write_text(json.dumps(config))
    assert run_setup(file,env,'--reconnect').returncode==1


def test_failed_probe_does_not_create_admin_and_can_resume(tmp_path):
    file,env,config=setup_config(tmp_path)
    root=Path(config['storage']['root']);root.write_text('not a directory')
    result=run_setup(file,env)
    assert result.returncode==1
    with sqlite3.connect(Path(env['YOURWIKI_DATA'])/'wiki.sqlite3') as db:
        assert db.execute('select count(*) from wiki_user').fetchone()[0]==0
        assert db.execute('select initialized from wiki_workspace').fetchone()[0]==0
    root.unlink();root.mkdir()
    assert run_setup(file,env).returncode==0


def test_backup_roundtrip(tmp_path):
    file,env,config=setup_config(tmp_path)
    assert run_setup(file,env).returncode==0
    env['DJANGO_SETTINGS_MODULE']='config.settings'
    output=tmp_path/'backup.sqlite3'
    command=[sys.executable,str(ROOT/'manage.py'),'backup',str(output)]
    result=subprocess.run(command,env=env,capture_output=True,text=True)
    assert result.returncode==0,result.stdout+result.stderr
    with sqlite3.connect(output) as db:
        assert db.execute('pragma integrity_check').fetchone()[0]=='ok'
        assert db.execute('select username from wiki_user').fetchone()[0]=='owner'
    assert subprocess.run(command,env=env,capture_output=True).returncode!=0


def test_doctor_reports_health_without_secrets(tmp_path):
    file,env,config=setup_config(tmp_path)
    assert run_setup(file,env).returncode==0
    env['DJANGO_SETTINGS_MODULE']='config.settings'
    command=[sys.executable,str(ROOT/'manage.py'),'doctor','--storage']
    result=subprocess.run(command,env=env,capture_output=True,text=True)
    assert result.returncode==0,result.stdout+result.stderr
    assert 'SQLite integrity: ok' in result.stdout
    assert 'Storage probe: passed' in result.stdout
    assert config['admin']['password'] not in result.stdout+result.stderr


def test_install_rejects_http_by_default(tmp_path):
    file,env,config=setup_config(tmp_path)
    result=subprocess.run([sys.executable,str(ROOT/'install.py'),'--config',str(file)],env=env,cwd=ROOT,capture_output=True,text=True)
    assert result.returncode==1
    assert 'HTTPS is required' in result.stdout
    assert not (Path(env['YOURWIKI_DATA'])/'wiki.sqlite3').exists()
