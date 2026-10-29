"""Bounded cache for decoded view-only content, never write validation or ACL."""
from collections import OrderedDict
import threading
import time

MAX_BYTES=32*1024*1024
MAX_ENTRY_BYTES=4*1024*1024
MAX_ENTRIES=128
TTL=30
_lock=threading.Lock()
_values=OrderedDict()
_inflight={}
_size=0


def key(document):
    return (str(document.pk),document.reference,document.storage_digest,document.revision,document.file_format,document.format_version)


def content(document,load):
    global _size
    identity=key(document)
    while True:
        with _lock:
            cached=_values.get(identity)
            if cached:
                value,expires,size=cached
                if time.monotonic()<expires:
                    _values.move_to_end(identity);return value
                _size-=size;del _values[identity]
            event=_inflight.get(identity)
            if event is None:
                event=_inflight[identity]=threading.Event();break
        event.wait()
    try:
        value=load()
        size=len(value.encode('utf8'))
        if size<=MAX_ENTRY_BYTES:
            with _lock:
                while _values and (_size+size>MAX_BYTES or len(_values)>=MAX_ENTRIES):
                    _,(_,_,removed)=_values.popitem(last=False);_size-=removed
                _values[identity]=(value,time.monotonic()+TTL,size);_size+=size
        return value
    finally:
        with _lock:
            _inflight.pop(identity,None);event.set()


def clear():
    global _size
    with _lock:_values.clear();_size=0
