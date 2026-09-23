import { authClient } from '@documenso/auth/client';
import { Button } from '@documenso/ui/primitives/button';
import { useState } from 'react';
import { FcGoogle } from 'react-icons/fc';

import type { SignInFormProps } from './signin';

/** Personal instance only. Upstream 2.11 ignores password sign-in UI flags. */
export function PersonalGoogleSignIn({ isGoogleSSOEnabled, returnTo }: SignInFormProps) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const signIn = async () => {
    setPending(true);
    setFailed(false);
    try {
      const target = new URL(returnTo || '/', window.location.origin);
      const redirectPath =
        target.origin === window.location.origin ? target.href : window.location.origin;
      await authClient.google.signIn({ redirectPath });
    } catch {
      setFailed(true);
      setPending(false);
    }
  };

  return (
    <div className="space-y-3">
      <Button
        className="w-full"
        variant="outline"
        disabled={!isGoogleSSOEnabled || pending}
        onClick={signIn}
      >
        <FcGoogle className="mr-2 h-5 w-5" aria-hidden />
        {pending ? 'Opening Google…' : 'Continue with Google'}
      </Button>
      {failed && (
        <p role="alert" className="text-sm">
          Unable to open Google sign-in. Please try again.
        </p>
      )}
      {!isGoogleSSOEnabled && (
        <p role="alert" className="text-sm">
          Google sign-in is temporarily unavailable.
        </p>
      )}
    </div>
  );
}
