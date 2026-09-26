import { afterEach, describe, expect, it, vi } from 'vitest';
import { DevCdpClient } from './phase-25-windows-smoke-helpers.mjs';
class Socket extends EventTarget {
  sent=[];
  send(text){this.sent.push(JSON.parse(text));}
  close(){this.closed=true;}
  message(data){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(data)}));}
}
afterEach(()=>vi.useRealTimers());
describe('native debug connection lifecycle',()=>{
  it('rejects an outstanding evaluation when the target detaches without closing its socket',async()=>{
    const socket=new Socket();const client=new DevCdpClient(socket);
    const result=client.evaluate('closeWindow()').then(()=> 'resolved',e=>e.message);
    socket.message({method:'Inspector.detached',params:{reason:'Render process gone.'}});
    expect(await Promise.race([result,new Promise(r=>setTimeout(()=>r('STILL PENDING'),50))])).toMatch(/detached/);
    expect(socket.closed).toBe(true);
  });
  it('bounds a silent request and clears pending work',async()=>{
    vi.useFakeTimers();const socket=new Socket();const client=new DevCdpClient(socket,{requestTimeoutMs:100});
    const result=client.send('Runtime.evaluate').catch(e=>e.message);
    await vi.advanceTimersByTimeAsync(101);
    expect(await Promise.race([result,Promise.resolve('STILL PENDING')])).toMatch(/timed out.*Runtime.evaluate/);
    expect(client.pending.size).toBe(0);expect(socket.closed).toBe(true);
  });
  it('settles pending work immediately on local close, even without a socket close event',async()=>{
    const client=new DevCdpClient(new Socket());const result=client.send('Page.captureScreenshot').catch(e=>e.message);client.close();
    expect(await Promise.race([result,new Promise(r=>setTimeout(()=>r('STILL PENDING'),50))])).toMatch(/closed/);
  });
  it('clears the deadline on a normal response',async()=>{
    vi.useFakeTimers();const socket=new Socket();const client=new DevCdpClient(socket,{requestTimeoutMs:100});
    const result=client.send('Runtime.evaluate');socket.message({id:1,result:{value:42}});
    expect(await result).toEqual({value:42});expect(vi.getTimerCount()).toBe(0);expect(client.pending.size).toBe(0);
  });
});
