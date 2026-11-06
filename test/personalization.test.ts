import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merge, signContact, verifyContact } from '../src/mail/personalization';
test('personalization escapes HTML and handles missing fields',()=>{
 assert.equal(merge('Hi {{first_name}} {{missing}}',{first_name:'<Ada & Co>'}),'Hi &lt;Ada &amp; Co&gt; ');
 assert.equal(merge('{{subject}}',{subject:'Hello\r\nBcc: bad'},false),'Hello  Bcc: bad');
});
test('unsubscribe tokens reject tampering and malformed values',()=>{
 const secret='a'.repeat(32);const token=signContact('contact-1',secret);
 assert.equal(verifyContact('contact-1',token,secret),true);
 assert.equal(verifyContact('contact-2',token,secret),false);
 assert.equal(verifyContact('contact-1','bad',secret),false);
 assert.equal(verifyContact('contact-1',token,'b'.repeat(32)),false);
});
