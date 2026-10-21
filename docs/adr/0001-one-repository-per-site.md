# One repository per Site, with the Factory inside it

Each Site gets its own repository, created by one install command, and the Factory (instructions, skills, Review checks, dashboard) lives inside that repository and is updated in place. The site machine this grew out of kept the machine in one repository and every site in another under a configured sites root; that split needs two repositories and a path setting before anything works, which is too much for a full beginner. A second Site means running the install command again.
